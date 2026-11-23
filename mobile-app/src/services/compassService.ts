/**
 * CompassService - 独立罗盘服务
 *
 * 解决问题：expo-location 的 watchHeadingAsync 在手机平放时方向正确，
 * 但手机竖着导航（如车载手机支架）时方向指示错乱。
 *
 * 主流解决方案（与高德/百度地图一致）：
 * 1. 同时订阅 Accelerometer（acceleration including gravity）和 Magnetometer（地磁场）
 * 2. 通过 Android SensorManager.getRotationMatrix 等价算法计算 3x3 旋转矩阵 R
 *    - R[0..2] = East 在设备坐标系下的分量
 *    - R[3..5] = North 在设备坐标系下的分量
 *    - R[6..8] = Up 在设备坐标系下的分量
 * 3. 根据手机姿态（pitch）动态选择"朝向轴"：
 *    - 平放（|pitch| < 60°）：用设备 +Y 轴（手机顶部）朝向
 *      azimuth = atan2(R[1], R[4]) = atan2(hy, My)
 *    - 竖屏（|pitch| >= 60°）：用设备 -Z 轴（手机背面，朝向行驶方向）朝向
 *      azimuth = atan2(-R[2], -R[5]) = atan2(-hz, -Mz)
 *
 * 关键约定：
 * - A = acceleration including gravity，平放时 z = +9.81（朝上）
 * - 不取反！与 Android Sensor.TYPE_ACCELEROMETER 一致
 *
 * 算法参考：Android Source - SensorManager.getRotationMatrix()
 * https://developer.android.com/reference/android/hardware/SensorManager#getRotationMatrix(float%5B%5D,%20float%5B%5D,%20float%5B%5D,%20float%5B%5D)
 */

import { Accelerometer, Magnetometer } from 'expo-sensors';

export type HeadingCallback = (heading: number | null) => void;

interface SensorVector {
  x: number;
  y: number;
  z: number;
}

// 平滑滤波器窗口大小，越大越平滑但延迟越高
const SMOOTH_WINDOW_SIZE = 8;
// 朝向变化最小阈值（度），低于此变化不通知，避免抖动
const HEADING_CHANGE_THRESHOLD = 3;
// 传感器采样间隔（毫秒）
const SENSOR_INTERVAL_MS = 100;

/**
 * 罗盘服务单例
 */
class CompassService {
  private accelSub: { remove: () => void } | null = null;
  private magSub: { remove: () => void } | null = null;

  private lastAccel: SensorVector | null = null;
  private lastMag: SensorVector | null = null;

  // 平滑滤波：环形缓冲
  private headingBuffer: number[] = [];
  private lastOutputHeading: number | null = null;

  private callback: HeadingCallback | null = null;
  private isRunning = false;

  /**
   * 启动罗盘监听
   */
  async start(onHeading: HeadingCallback): Promise<void> {
    if (this.isRunning) {
      this.callback = onHeading;
      return;
    }
    this.isRunning = true;
    this.callback = onHeading;
    this.lastAccel = null;
    this.lastMag = null;
    this.headingBuffer = [];
    this.lastOutputHeading = null;

    Accelerometer.setUpdateInterval(SENSOR_INTERVAL_MS);
    Magnetometer.setUpdateInterval(SENSOR_INTERVAL_MS);

    try {
      this.accelSub = Accelerometer.addListener((data) => {
        // expo-sensors Accelerometer 返回 acceleration including gravity
        // 平放屏幕朝上时 z ≈ +9.81（朝上），与 Android Sensor.TYPE_ACCELEROMETER 一致
        // Android SensorManager.getRotationMatrix 期望相同输入，无需取反
        // 注意：之前版本错误地取反，导致方位角偏 180°
        this.lastAccel = { x: data.x, y: data.y, z: data.z };
        this.tryComputeHeading();
      });
    } catch (e: any) {
      console.warn('[CompassService] Accelerometer 订阅失败:', e?.message || e);
    }

    try {
      this.magSub = Magnetometer.addListener((data) => {
        // 地磁场向量，单位 μT，方向：x 朝右、y 朝上、z 朝外（屏幕方向）
        this.lastMag = { x: data.x, y: data.y, z: data.z };
        this.tryComputeHeading();
      });
    } catch (e: any) {
      console.warn('[CompassService] Magnetometer 订阅失败:', e?.message || e);
    }

    console.log('[CompassService] 罗盘监听已启动');
  }

  /**
   * 停止罗盘监听
   */
  stop(): void {
    if (this.accelSub) {
      this.accelSub.remove();
      this.accelSub = null;
    }
    if (this.magSub) {
      this.magSub.remove();
      this.magSub = null;
    }
    this.isRunning = false;
    this.callback = null;
    this.lastAccel = null;
    this.lastMag = null;
    this.headingBuffer = [];
    this.lastOutputHeading = null;
    console.log('[CompassService] 罗盘监听已停止');
  }

  /**
   * 尝试计算朝向（需要 accel 和 mag 同时可用）
   */
  private tryComputeHeading(): void {
    if (!this.lastAccel || !this.lastMag) return;
    if (!this.callback) return;

    const heading = this.computeHeadingFromSensors(this.lastAccel, this.lastMag);
    if (heading === null || isNaN(heading)) return;

    // 平滑滤波：环形缓冲 + 角度平均（处理 0/360 边界）
    this.pushToBuffer(heading);
    const smoothed = this.getSmoothedHeading();
    if (smoothed === null) return;

    // 朝向变化阈值过滤
    if (this.lastOutputHeading !== null) {
      const diff = Math.abs(this.angleDiff(smoothed, this.lastOutputHeading));
      if (diff < HEADING_CHANGE_THRESHOLD) return;
    }
    this.lastOutputHeading = smoothed;
    this.callback(smoothed);
  }

  /**
   * 核心算法：从 accel + mag 计算朝向
   * 等价于 Android SensorManager.getRotationMatrix + getOrientation
   * 但根据手机姿态做适配，解决竖屏朝向问题
   *
   * 关键约定：
   * - accel = acceleration including gravity，平放时 A = (0, 0, +9.81) 朝上
   *   （与 Android Sensor.TYPE_ACCELEROMETER 一致，不取反）
   * - mag = 地磁场向量
   * - H = E × A（叉积，East 方向）
   * - M = A × H（叉积，North 方向）
   * - R = [H; M; A] (3x3 行优先)
   *   - R[0..2] = h = East 在设备坐标系下
   *   - R[3..5] = M = North 在设备坐标系下
   *   - R[6..8] = a = Up 在设备坐标系下
   */
  private computeHeadingFromSensors(accel: SensorVector, mag: SensorVector): number | null {
    // === Step 1: 计算旋转矩阵 R（Android getRotationMatrix 等价实现）===
    const ax = accel.x, ay = accel.y, az = accel.z;   // A = acceleration including gravity
    const ex = mag.x, ey = mag.y, ez = mag.z;          // E = geomagnetic field

    // H = E × A（East 方向）
    const Hx = ey * az - ez * ay;
    const Hy = ez * ax - ex * az;
    const Hz = ex * ay - ey * ax;

    const normH = Math.sqrt(Hx * Hx + Hy * Hy + Hz * Hz);
    if (normH < 1e-6) return null;

    const invH = 1.0 / normH;
    const hx = Hx * invH;
    const hy = Hy * invH;
    const hz = Hz * invH;

    // A normalized
    const normA = Math.sqrt(ax * ax + ay * ay + az * az);
    if (normA < 1e-6) return null;
    const invA = 1.0 / normA;
    const axn = ax * invA;
    const ayn = ay * invA;
    const azn = az * invA;

    // M = A × H（North 方向）
    const Mx = ayn * hz - azn * hy;
    const My = azn * hx - axn * hz;
    const Mz = axn * hy - ayn * hx;

    // 旋转矩阵 R（3x3，行优先）
    // R = [ hx  hy  hz ]   <- East 在设备坐标系下
    //     [ Mx  My  Mz ]   <- North 在设备坐标系下
    //     [ axn ayn azn]   <- Up 在设备坐标系下（朝上）

    // === Step 2: 计算 pitch（手机俯仰角）判断姿态 ===
    // Android getOrientation: pitch = asin(-R[7]) = asin(-ayn)
    // pitch = 0 时手机平放，pitch = ±90° 时手机竖直
    const aynClamped = Math.max(-1, Math.min(1, ayn));
    const pitch = Math.asin(-aynClamped);
    const pitchDeg = pitch * 180 / Math.PI;

    // === Step 3: 根据姿态计算 azimuth ===
    // Android getOrientation: azimuth = atan2(R[1], R[4]) = atan2(hy, My)
    // - 平放时此公式稳定（设备 +Y 轴有水平分量）
    // - 竖屏时（|pitch| > 60°）设备 +Y 轴接近垂直，公式因 gimbal lock 不稳定
    //
    // 竖屏解决方案：改用设备 -Z 轴（手机背面）在水平面的投影
    // 设备 -Z 轴在世界坐标系下的 East/North 分量 = (-hz, -Mz)
    // 对应车载手机支架场景：手机竖立、屏幕朝向驾驶员、背面朝向前方（行驶方向）
    let azimuthRad: number;

    if (Math.abs(pitchDeg) < 60) {
      // 平放或接近平放：用 +Y 轴（手机顶部）方向计算朝向
      azimuthRad = Math.atan2(hy, My);
    } else {
      // 竖直姿态：用 -Z 轴（手机背面）方向计算朝向
      azimuthRad = Math.atan2(-hz, -Mz);
    }

    // 转换为 0-360 度
    let azimuth = azimuthRad * 180 / Math.PI;
    azimuth = (azimuth + 360) % 360;

    return azimuth;
  }

  /**
   * 将朝向推入环形缓冲（处理 0/360 边界）
   */
  private pushToBuffer(heading: number): void {
    this.headingBuffer.push(heading);
    if (this.headingBuffer.length > SMOOTH_WINDOW_SIZE) {
      this.headingBuffer.shift();
    }
  }

  /**
   * 平均滤波（角度边界处理）
   */
  private getSmoothedHeading(): number | null {
    if (this.headingBuffer.length === 0) return null;
    const buf = this.headingBuffer;

    // 检查是否跨越 0/360 边界
    let hasWrap = false;
    for (let i = 1; i < buf.length; i++) {
      const diff = Math.abs(buf[i] - buf[i - 1]);
      if (diff > 180) {
        hasWrap = true;
        break;
      }
    }

    if (!hasWrap) {
      // 简单平均
      return buf.reduce((s, v) => s + v, 0) / buf.length;
    }

    // 跨边界：用三角函数平均（向量平均）
    let sumSin = 0, sumCos = 0;
    for (const h of buf) {
      const r = h * Math.PI / 180;
      sumSin += Math.sin(r);
      sumCos += Math.cos(r);
    }
    const avg = Math.atan2(sumSin, sumCos) * 180 / Math.PI;
    return (avg + 360) % 360;
  }

  /**
   * 角度差（带符号，-180 ~ 180）
   */
  private angleDiff(a: number, b: number): number {
    let d = a - b;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
  }
}

export const compassService = new CompassService();
