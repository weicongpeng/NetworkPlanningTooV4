import React, { useState, useEffect, useCallback } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert,
  TextInput, Modal, ActivityIndicator, Switch, Platform, Appearance,
  ToastAndroid, Share, TouchableWithoutFeedback,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { Clipboard } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { apiService } from '../../src/services/api';
import { cacheService } from '../../src/services/cacheService';
import { downloadApk, installApk, DownloadProgressInfo } from '../../src/services/downloadService';
import { login as authLogin, register as authRegister, logout as authLogout, fetchMe, getStoredUser, AuthUser } from '../../src/services/auth';
import { useMapStore, NavTrackItem } from '../../src/store/mapStore';
import { useHeartbeat } from '../../src/hooks/useHeartbeat';

// 配色方案（统一类型，便于 SettingRow/Divider 接收 LIGHT 或 DARK）
type AppColors = {
  bg: string;
  card: string;
  cardBorder: string;
  divider: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  danger: string;
  success: string;
  avatarBg: string;
  inputBg: string;
  switchTrackFalse: string;
  overlayBg: string;
};

// 浅色配色方案
const LIGHT_COLORS: AppColors = {
  bg: '#f5f5f5',
  card: '#FFFFFF',
  cardBorder: '#E5E5E5',
  divider: '#EEEEEE',
  textPrimary: '#1A1A1A',
  textSecondary: '#666666',
  textMuted: '#999999',
  accent: '#007AFF',
  danger: '#E53935',
  success: '#16A34A',
  avatarBg: '#FFB300',
  inputBg: '#f0f0f0',
  switchTrackFalse: '#E0E0E0',
  overlayBg: 'rgba(0,0,0,0.4)',
} as const;

// 深色配色方案
const DARK_COLORS: AppColors = {
  bg: '#2B2B2F',
  card: '#36363A',
  cardBorder: '#4A4A50',
  divider: '#424248',
  textPrimary: '#E8E6E3',
  textSecondary: '#B0AEA8',
  textMuted: '#8A8880',
  accent: '#7EB6F6',
  danger: '#F07070',
  success: '#7EC87E',
  avatarBg: '#C49A2A',
  inputBg: '#3A3A3F',
  switchTrackFalse: '#55555A',
  overlayBg: 'rgba(0,0,0,0.55)',
} as const;

// 本地用户信息键（仅保留旧版 userInfo 用于回退读取；appSettings/navTracks 改由 mapStore persist 管理）
const STORAGE_KEYS = {
  userInfo: '@profile_user_info',  // 兼容旧版（保留用于回退读取）
};

// 运营商列表（与 PC 端 /admin/app-users 注册页面一致）
const OPERATORS = ['移动', '电信', '联通', '广电'] as const;
type Operator = typeof OPERATORS[number];

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();
  // 全局登录状态：用于其他 Tab 判断是否可操作
  const setLoggedInGlobal = useMapStore((s) => s.setLoggedIn);
  const clearLoggedInGlobal = useMapStore((s) => s.clearLoggedIn);
  // 全局当前用户（响应式订阅，确保 admin 判断实时更新）
  const currentUser = useMapStore((s) => s.currentUser);
  // 全局深色模式
  const darkMode = useMapStore((s) => s.darkMode);
  const setDarkModeGlobal = useMapStore((s) => s.setDarkMode);
  // 全局应用设置（持久化到 mapStore，退出登录后仍保留）
  const appSettings = useMapStore((s) => s.appSettings);
  const setAppSettingsGlobal = useMapStore((s) => s.setAppSettings);
  // 全局导航记录（持久化到 mapStore，退出登录后仍保留）
  const navTracks = useMapStore((s) => s.navTracks);
  const clearNavTracksGlobal = useMapStore((s) => s.clearNavTracks);
  // 动态配色
  const COLORS = darkMode ? DARK_COLORS : LIGHT_COLORS;

  // 心跳保活：登录后每 5 分钟自动调 /auth/ping
  useHeartbeat();

  // 用户状态
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userInfo, setUserInfo] = useState<AuthUser | null>(null);

  // admin 权限判断（响应式：依赖 userInfo + 全局 currentUser）
  const isAdmin = React.useMemo(() => {
    const u = userInfo || currentUser;
    if (!u) return false;
    const ut = (u.user_type || u.role || '').toLowerCase();
    const result = ut === 'admin'
      || u.is_admin === true
      || u.is_admin === 1
      || u.is_admin === '1'
      || (u.username && u.username.toLowerCase() === 'admin');
    console.log('[Profile] isAdmin check:', JSON.stringify({ username: u.username, user_type: u.user_type, role: u.role, is_admin: u.is_admin, result }));
    return result;
  }, [userInfo, currentUser]);

  const [loginModalVisible, setLoginModalVisible] = useState(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [currentApiUrl, setCurrentApiUrl] = useState('');

  // 注册状态
  const [registerModalVisible, setRegisterModalVisible] = useState(false);
  const [regUsername, setRegUsername] = useState('');
  const [regCity, setRegCity] = useState('');
  const [regOperator, setRegOperator] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regPasswordConfirm, setRegPasswordConfirm] = useState('');
  const [regLoading, setRegLoading] = useState(false);
  const [operatorPickerVisible, setOperatorPickerVisible] = useState(false);

  // 子页面 modal
  const [aboutModalVisible, setAboutModalVisible] = useState(false);
  const [tracksModalVisible, setTracksModalVisible] = useState(false);
  const [appSettingsModalVisible, setAppSettingsModalVisible] = useState(false);

  // 缓存大小
  const [cacheSize, setCacheSize] = useState<number>(0);
  const [clearingCache, setClearingCache] = useState(false);

  // 应用更新检查与下载
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloadModalVisible, setDownloadModalVisible] = useState(false);
  const [downloadPercent, setDownloadPercent] = useState(0);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [totalBytes, setTotalBytes] = useState(0);
  const [downloadPhase, setDownloadPhase] = useState<'idle' | 'downloading' | 'installing' | 'done' | 'error'>('idle');

  /**
   * 检查应用更新：调 apiService.checkAppVersion() 比对版本号
   * - 有新版：弹确认框 → 应用内下载（Tailscale 优先）→ 调起安装器
   * - 无新版：Toast 提示已是最新
   */
  const handleCheckUpdate = useCallback(async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const latest = await apiService.checkAppVersion();
      if (!latest || !latest.version) {
        Alert.alert('检查失败', '无法获取版本信息，请检查网络或后端地址');
        return;
      }

      const currentVersion = Constants.expoConfig?.version || '2.0.0';
      const isNewer = (server: string, current: string): boolean => {
        try {
          const sp = server.split('.').map(Number);
          const cp = current.split('.').map(Number);
          for (let i = 0; i < Math.max(sp.length, cp.length); i++) {
            const sv = sp[i] || 0;
            const cv = cp[i] || 0;
            if (sv !== cv) return sv > cv;
          }
          return false;
        } catch {
          return server !== current;
        }
      };

      if (!isNewer(latest.version, currentVersion)) {
        Alert.alert('已是最新版本', `当前版本 V${currentVersion}`);
        return;
      }

      // 构建完整下载 URL
      const baseUrl = await apiService.getCurrentBaseUrl();
      const downloadUrl = latest.download_url?.startsWith('http')
        ? latest.download_url
        : `${baseUrl.replace(/\/api\/v1\/?$/, '')}${latest.download_url || ''}`;

      if (!downloadUrl) {
        Alert.alert('错误', '未获取到下载地址');
        return;
      }

      Alert.alert(
        '发现新版本',
        `最新版本: V${latest.version}${latest.file_size_display ? ` (${latest.file_size_display})` : ''}\n\n` +
        (latest.changelog ? `更新说明:\n${latest.changelog}\n\n` : '') +
        '是否立即下载更新？',
        [
          { text: '稍后再说', style: 'cancel' },
          {
            text: '立即下载',
            onPress: () => {
              setDownloadPercent(0);
              setDownloadedBytes(0);
              setTotalBytes(0);
              setDownloadPhase('downloading');
              setDownloadModalVisible(true);

              downloadApk(downloadUrl, baseUrl, (info: DownloadProgressInfo) => {
                setDownloadPercent(info.percent);
                setDownloadedBytes(info.downloadedBytes);
                setTotalBytes(info.totalBytes);
              })
                .then(async (result) => {
                  if (result.ok) {
                    setDownloadPhase('installing');
                    try {
                      await installApk(result.uri);
                      setDownloadPhase('done');
                    } catch (e: any) {
                      setDownloadPhase('error');
                      Alert.alert(
                        '安装失败',
                        'APK 已下载但无法直接安装。\n\n' + (e?.message || ''),
                        [{ text: '知道了' }],
                      );
                    }
                  } else {
                    setDownloadPhase('error');
                    Alert.alert(
                      '下载失败',
                      '是否使用浏览器下载？\n\n' + (result as any).error,
                      [
                        { text: '取消', style: 'cancel' },
                        {
                          text: '浏览器下载',
                          onPress: () => {
                            const { Linking } = require('react-native');
                            Linking.openURL(downloadUrl).catch(() => {});
                          },
                        },
                      ],
                    );
                  }
                })
                .catch((e) => {
                  setDownloadPhase('error');
                  Alert.alert('下载失败', e?.message || '未知错误');
                });
            },
          },
        ],
      );
    } catch (e: any) {
      Alert.alert('检查失败', e?.message || '未知错误');
    } finally {
      setCheckingUpdate(false);
    }
  }, [checkingUpdate]);

  // 加载本地数据
  useEffect(() => {
    (async () => {
      try {
        // 优先从 auth 服务存储读取（包含 token 关联的最新用户信息）
        const stored = await getStoredUser();
        if (stored) {
          console.log('[Profile] stored user:', JSON.stringify(stored));
          setUserInfo(stored);
          setIsLoggedIn(true);
          setLoggedInGlobal(stored);
        } else {
          // 回退到旧版存储，避免老用户掉登录
          const u = await AsyncStorage.getItem(STORAGE_KEYS.userInfo);
          if (u) {
            const parsed = JSON.parse(u);
            setUserInfo(parsed);
            setIsLoggedIn(true);
            setLoggedInGlobal(parsed);
          }
        }
        // appSettings / navTracks / darkMode 由 mapStore persist 自动恢复
        // 若有 token，尝试拉取一次最新用户信息（静默失败不打扰用户）
        try {
          const me = await fetchMe();
          if (me) {
            setUserInfo(me);
            setIsLoggedIn(true);
            setLoggedInGlobal(me);
          }
        } catch { /* token 无效或后端不可达，使用本地缓存 */ }
      } catch (e) {
        console.warn('[Profile] load local data failed', e);
      }
      const url = await apiService.getCurrentBaseUrl();
      setCurrentApiUrl(url);
    })();
  }, []);

  // 深色模式切换时同步系统 Appearance，使所有页面自动适配
  useEffect(() => {
    Appearance.setColorScheme(darkMode ? 'dark' : 'light');
  }, [darkMode]);

  // 登录（调用后端 /api/v1/auth/login）
  const handleLogin = useCallback(async () => {
    const username = loginUsername.trim();
    const password = loginPassword;
    if (!username || !password) {
      Alert.alert('提示', '请输入用户名和密码');
      return;
    }
    setLoginLoading(true);
    try {
      const result = await authLogin(username, password);
      setUserInfo(result.user);
      setIsLoggedIn(true);
      setLoggedInGlobal(result.user);  // 同步到全局 store，其他 Tab 解锁
      // 同步一份到旧版存储（兼容）
      await AsyncStorage.setItem(STORAGE_KEYS.userInfo, JSON.stringify(result.user));
      setLoginModalVisible(false);
      setLoginUsername('');
      setLoginPassword('');
      Alert.alert('登录成功', `欢迎，${result.user.username}`);
    } catch (e: any) {
      Alert.alert('登录失败', e?.message || '请稍后重试');
    } finally {
      setLoginLoading(false);
    }
  }, [loginUsername, loginPassword]);

  // 注册（调用后端 /api/v1/auth/register，body 含地市/运营商，注册后自动获得 PC+APP 访问权）
  const handleRegister = useCallback(async () => {
    const username = regUsername.trim();
    const city = regCity.trim();
    const operator = regOperator;
    const password = regPassword;
    const passwordConfirm = regPasswordConfirm;
    if (!username) { Alert.alert('提示', '请输入用户名'); return; }
    if (username.length < 3) { Alert.alert('提示', '用户名至少 3 个字符'); return; }
    if (!city) { Alert.alert('提示', '请输入地市'); return; }
    if (!operator) { Alert.alert('提示', '请选择运营商'); return; }
    if (!password) { Alert.alert('提示', '请输入密码'); return; }
    if (password.length < 6) { Alert.alert('提示', '密码至少 6 个字符'); return; }
    if (password !== passwordConfirm) { Alert.alert('提示', '两次输入的密码不一致'); return; }
    setRegLoading(true);
    try {
      const result = await authRegister(username, password, { city, operator });
      setUserInfo(result.user);
      setIsLoggedIn(true);
      setLoggedInGlobal(result.user);  // 同步到全局 store
      await AsyncStorage.setItem(STORAGE_KEYS.userInfo, JSON.stringify(result.user));
      setRegisterModalVisible(false);
      setRegUsername('');
      setRegCity('');
      setRegOperator('');
      setRegPassword('');
      setRegPasswordConfirm('');
      Alert.alert(
        '注册成功',
        `欢迎加入，${result.user.username}\n\n已自动开通 PC + APP 双重访问权限`,
      );
    } catch (e: any) {
      Alert.alert('注册失败', e?.message || '请稍后重试');
    } finally {
      setRegLoading(false);
    }
  }, [regUsername, regCity, regOperator, regPassword, regPasswordConfirm]);

  // 打开注册弹框（从登录弹框切换）
  const openRegister = useCallback(() => {
    setLoginModalVisible(false);
    setLoginUsername('');
    setLoginPassword('');
    setRegisterModalVisible(true);
  }, []);

  // 关闭注册弹框时清空表单
  const closeRegister = useCallback(() => {
    setRegisterModalVisible(false);
    setRegUsername('');
    setRegCity('');
    setRegOperator('');
    setRegPassword('');
    setRegPasswordConfirm('');
  }, []);

  // 选择运营商
  const selectOperator = useCallback((op: Operator) => {
    setRegOperator(op);
    setOperatorPickerVisible(false);
  }, []);

  // 退出登录（清除后端 token + 本地用户信息 + 全局状态）
  const handleLogout = useCallback(() => {
    Alert.alert('退出确认', '确定要退出登录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出', style: 'destructive', onPress: async () => {
          await authLogout();
          setIsLoggedIn(false);
          setUserInfo(null);
          clearLoggedInGlobal();  // 同步全局，其他 Tab 立即进入预览态
          await AsyncStorage.removeItem(STORAGE_KEYS.userInfo);
        },
      },
    ]);
  }, [clearLoggedInGlobal]);

  const handleToggleDarkMode = (v: boolean) => {
    setDarkModeGlobal(v);
  };
  const handleToggleAutoSync = (v: boolean) => {
    setAppSettingsGlobal({ autoSync: v });
  };
  const handleToggleTts = (v: boolean) => {
    setAppSettingsGlobal({ ttsEnabled: v });
  };

  // 加载缓存大小
  const refreshCacheSize = useCallback(async () => {
    try {
      const size = await cacheService.getCacheSize();
      setCacheSize(size);
    } catch (e) {
      console.warn('[Profile] getCacheSize failed', e);
    }
  }, []);

  // 清除缓存
  const handleClearCache = useCallback(() => {
    Alert.alert('清除缓存', '确定要清除所有本地缓存数据吗？清除后需重新加载工参。', [
      { text: '取消', style: 'cancel' },
      {
        text: '清除', style: 'destructive', onPress: async () => {
          setClearingCache(true);
          try {
            await cacheService.clearCache();
            setCacheSize(0);
            // 重置缓存相关全局状态 + 清空内存中的扇区数据
            useMapStore.getState().setSectors([], []);
            useMapStore.getState().setCacheAvailable(false);
            useMapStore.getState().setCacheUpdatedAt(null);
            Alert.alert('提示', '缓存已清除');
          } catch (e) {
            Alert.alert('错误', '清除缓存失败，请重试');
          } finally {
            setClearingCache(false);
          }
        },
      },
    ]);
  }, []);

  // 导航记录 - 清空
  const handleClearTracks = useCallback(() => {
    if (navTracks.length === 0) return;
    Alert.alert('清空确认', '确定要清空所有导航记录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空', style: 'destructive', onPress: () => {
          clearNavTracksGlobal();
        },
      },
    ]);
  }, [navTracks.length, clearNavTracksGlobal]);

  // 格式化时长
  const formatDuration = (sec: number) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
  };
  const formatDistance = (m: number) => {
    if (m > 1000) return `${(m / 1000).toFixed(2)} km`;
    return `${Math.round(m)} m`;
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top, backgroundColor: COLORS.bg }]}>
      <StatusBar style={darkMode ? 'light' : 'dark'} />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* 顶部标题 */}
        <View style={[styles.header, { backgroundColor: COLORS.bg }]}>
          <Text style={[styles.title, { color: COLORS.textPrimary }]}>我的</Text>
        </View>

        {/* 用户卡片 */}
        <View style={[styles.userCard, { backgroundColor: COLORS.card }]}>
          <View style={styles.avatarWrap}>
            <View style={[styles.avatar, { backgroundColor: COLORS.avatarBg }]}>
              <Text style={styles.avatarText}>
                {isLoggedIn
                  ? (userInfo?.avatar || userInfo?.username?.substring(0, 1)?.toUpperCase() || 'U')
                  : '访'}
              </Text>
            </View>
          </View>
          <View style={styles.userInfo}>
            {isLoggedIn ? (
              <>
                <Text style={[styles.userName, { color: COLORS.textPrimary }]}>{userInfo?.username}</Text>
                <Text style={[styles.userEmail, { color: COLORS.textMuted }]} numberOfLines={1}>
                  {userInfo?.email
                    || (userInfo?.city && userInfo?.operator ? `${userInfo.city} · ${userInfo.operator}` : null)
                    || '已登录'}
                </Text>
              </>
            ) : (
              <>
                <Text style={[styles.userName, { color: COLORS.textPrimary }]}>未登录</Text>
                <Text style={[styles.userEmail, { color: COLORS.textMuted }]}>登录后同步数据</Text>
              </>
            )}
          </View>
          {isLoggedIn ? (
            <TouchableOpacity style={[styles.logoutBtn, { borderColor: COLORS.cardBorder }]} onPress={handleLogout}>
              <Text style={[styles.logoutBtnText, { color: COLORS.danger }]}>退出</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={[styles.loginBtn, { backgroundColor: COLORS.accent }]}
              onPress={() => setLoginModalVisible(true)}
            >
              <Text style={styles.loginBtnText}>登录</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* 设置入口 */}
        <View style={[styles.card, { backgroundColor: COLORS.card }]}>
          <SettingRow
            icon="◐" title="设置" subtitle={`深色 ${darkMode ? '开' : '关'} · 同步 ${appSettings.autoSync ? '开' : '关'} · 语音 ${appSettings.ttsEnabled ? '开' : '关'}`}
            onPress={() => setAppSettingsModalVisible(true)}
            colors={COLORS}
          />
          <Divider colors={COLORS} />
          <SettingRow
            icon={<FootprintIcon color="#000000" size={18} />}
            title="我的足迹" subtitle={navTracks.length > 0 ? `${navTracks.length} 条轨迹` : '暂无足迹'}
            onPress={() => setTracksModalVisible(true)}
            colors={COLORS}
          />
        </View>

        {/* 关于 */}
        <View style={[styles.card, { backgroundColor: COLORS.card }]}>
          <SettingRow
            icon="ⓘ" title="关于" subtitle="版本与服务信息"
            onPress={() => setAboutModalVisible(true)}
            colors={COLORS}
          />
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* 登录弹框 */}
      <Modal visible={loginModalVisible} transparent animationType="fade" onRequestClose={() => setLoginModalVisible(false)}>
        <View style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}>
          <View style={[styles.loginModalContent, { backgroundColor: COLORS.card }]}>
            <Text style={[styles.loginModalTitle, { color: COLORS.textPrimary }]}>登录账号</Text>
            <Text style={[styles.loginModalSubtitle, { color: COLORS.textMuted }]}>登录后将同步您的数据到云端</Text>
            <TextInput
              style={[styles.loginInput, { borderColor: COLORS.cardBorder, color: COLORS.textPrimary, backgroundColor: COLORS.inputBg }]}
              value={loginUsername}
              onChangeText={setLoginUsername}
              placeholder="用户名"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <TextInput
              style={[styles.loginInput, { borderColor: COLORS.cardBorder, color: COLORS.textPrimary, backgroundColor: COLORS.inputBg }]}
              value={loginPassword}
              onChangeText={setLoginPassword}
              placeholder="密码"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
            />
            <View style={styles.loginModalActions}>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnGhost, { backgroundColor: COLORS.inputBg, borderColor: COLORS.cardBorder }]}
                onPress={() => { setLoginModalVisible(false); setLoginUsername(''); setLoginPassword(''); }}
                disabled={loginLoading}
              >
                <Text style={[styles.loginModalBtnGhostText, { color: COLORS.textPrimary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnPrimary, { backgroundColor: COLORS.accent }]}
                onPress={handleLogin}
                disabled={loginLoading}
              >
                {loginLoading
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.loginModalBtnPrimaryText}>登录</Text>}
              </TouchableOpacity>
            </View>
            {/* 注册入口 */}
            <View style={styles.registerEntry}>
              <Text style={[styles.registerEntryText, { color: COLORS.textMuted }]}>还没有账号？</Text>
              <TouchableOpacity onPress={openRegister} disabled={loginLoading} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={[styles.registerEntryLink, { color: COLORS.accent }]}>立即注册</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 注册弹框 */}
      <Modal visible={registerModalVisible} transparent animationType="fade" onRequestClose={closeRegister}>
        <View style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}>
          <View style={[styles.loginModalContent, { backgroundColor: COLORS.card }]}>
            <Text style={[styles.loginModalTitle, { color: COLORS.textPrimary }]}>注册账号</Text>
            <Text style={[styles.loginModalSubtitle, { color: COLORS.textMuted }]}>注册后即可同步数据到云端</Text>
            <TextInput
              style={[styles.loginInput, { borderColor: COLORS.cardBorder, color: COLORS.textPrimary, backgroundColor: COLORS.inputBg }]}
              value={regUsername}
              onChangeText={setRegUsername}
              placeholder="用户名（至少 3 个字符）"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <TextInput
              style={[styles.loginInput, { borderColor: COLORS.cardBorder, color: COLORS.textPrimary, backgroundColor: COLORS.inputBg }]}
              value={regPassword}
              onChangeText={setRegPassword}
              placeholder="密码（至少 6 个字符）"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
            />
            <TextInput
              style={[styles.loginInput, { borderColor: COLORS.cardBorder, color: COLORS.textPrimary, backgroundColor: COLORS.inputBg }]}
              value={regPasswordConfirm}
              onChangeText={setRegPasswordConfirm}
              placeholder="确认密码"
              placeholderTextColor={COLORS.textMuted}
              secureTextEntry
            />
            <TextInput
              style={[styles.loginInput, { borderColor: COLORS.cardBorder, color: COLORS.textPrimary, backgroundColor: COLORS.inputBg }]}
              value={regCity}
              onChangeText={setRegCity}
              placeholder="请输入地市名称"
              placeholderTextColor={COLORS.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            {/* 运营商下拉（移动端用点击弹出选择器） */}
            <TouchableOpacity
              style={[styles.loginInput, { borderColor: COLORS.cardBorder, backgroundColor: COLORS.inputBg }]}
              onPress={() => setOperatorPickerVisible(true)}
              activeOpacity={0.6}
              disabled={regLoading}
            >
              <Text style={regOperator ? [styles.loginInputValue, { color: COLORS.textPrimary }] : [styles.loginInputPlaceholder, { color: COLORS.textMuted }]}>
                {regOperator || '请选择运营商'}
              </Text>
              <Text style={[styles.loginInputChevron, { color: COLORS.textMuted }]}>▾</Text>
            </TouchableOpacity>
            <View style={styles.loginModalActions}>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnGhost, { backgroundColor: COLORS.inputBg, borderColor: COLORS.cardBorder }]}
                onPress={closeRegister}
                disabled={regLoading}
              >
                <Text style={[styles.loginModalBtnGhostText, { color: COLORS.textPrimary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnPrimary, { backgroundColor: COLORS.accent }]}
                onPress={handleRegister}
                disabled={regLoading}
              >
                {regLoading
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.loginModalBtnPrimaryText}>注册</Text>}
              </TouchableOpacity>
            </View>
            {/* 返回登录入口 */}
            <View style={styles.registerEntry}>
              <Text style={[styles.registerEntryText, { color: COLORS.textMuted }]}>已有账号？</Text>
              <TouchableOpacity onPress={() => { closeRegister(); setLoginModalVisible(true); }} disabled={regLoading} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={[styles.registerEntryLink, { color: COLORS.accent }]}>返回登录</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 运营商选择器（底部弹层） */}
      <Modal visible={operatorPickerVisible} transparent animationType="fade" onRequestClose={() => setOperatorPickerVisible(false)}>
        <TouchableOpacity
          style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}
          activeOpacity={1}
          onPress={() => setOperatorPickerVisible(false)}
        >
          <View style={[styles.operatorSheet, { backgroundColor: COLORS.card }]}>
            <View style={[styles.operatorSheetHeader, { borderBottomColor: COLORS.divider }]}>
              <Text style={[styles.operatorSheetTitle, { color: COLORS.textPrimary }]}>请选择运营商</Text>
              <TouchableOpacity onPress={() => setOperatorPickerVisible(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={[styles.operatorSheetClose, { color: COLORS.textMuted }]}>×</Text>
              </TouchableOpacity>
            </View>
            {OPERATORS.map((op) => (
              <TouchableOpacity
                key={op}
                style={[styles.operatorItem, { borderBottomColor: COLORS.divider }]}
                onPress={() => selectOperator(op)}
                activeOpacity={0.6}
              >
                <Text style={[styles.operatorItemText, { color: COLORS.textPrimary }]}>{op}</Text>
                {regOperator === op && <Text style={[styles.operatorItemCheck, { color: COLORS.accent }]}>✓</Text>}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

      {/* 个性/应用设置弹框 */}
      <Modal visible={appSettingsModalVisible} transparent animationType="slide" onRequestClose={() => setAppSettingsModalVisible(false)}
        onShow={refreshCacheSize}
      >
        <View style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}>
          <View style={[styles.sheetModal, { maxHeight: '80%', backgroundColor: COLORS.card }]}>
            <View style={[styles.sheetHeader, { borderBottomColor: COLORS.divider }]}>
              <Text style={[styles.sheetTitle, { color: COLORS.textPrimary }]}>设置</Text>
              <TouchableOpacity onPress={() => setAppSettingsModalVisible(false)}>
                <Text style={[styles.sheetClose, { color: COLORS.accent }]}>完成</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.sheetBody}>
              <Text style={[styles.sheetSection, { color: COLORS.textMuted }]}>设置</Text>
              <View style={[styles.sheetCard, { backgroundColor: COLORS.card }]}>
                <SettingSwitchRow
                  title="深色模式"
                  subtitle="切换应用深色主题"
                  value={darkMode}
                  onValueChange={handleToggleDarkMode}
                  trackFalseColor={COLORS.switchTrackFalse}
                  colors={COLORS}
                />
                <Divider colors={COLORS} />
                <SettingSwitchRow
                  title="自动同步"
                  subtitle="启动时自动同步最新工参"
                  value={appSettings.autoSync}
                  onValueChange={handleToggleAutoSync}
                  trackFalseColor={COLORS.switchTrackFalse}
                  colors={COLORS}
                />
                <Divider colors={COLORS} />
                <SettingSwitchRow
                  title="语音播报"
                  subtitle="导航过程中播报转向"
                  value={appSettings.ttsEnabled}
                  onValueChange={handleToggleTts}
                  trackFalseColor={COLORS.switchTrackFalse}
                  colors={COLORS}
                />
              </View>

              <Text style={[styles.sheetSection, { color: COLORS.textMuted }]}>存储</Text>
              <View style={[styles.sheetCard, { backgroundColor: COLORS.card }]}>
                <TouchableOpacity
                  style={styles.settingRow}
                  onPress={handleClearCache}
                  disabled={clearingCache}
                  activeOpacity={0.6}
                >
                  <View style={styles.settingTextBlock}>
                    <Text style={[styles.settingTitle, { color: COLORS.danger }]}>清除缓存</Text>
                    <Text style={[styles.settingSubtitle, { color: COLORS.textMuted }]}>
                      {cacheSize > 0
                        ? `当前缓存 ${(cacheSize / 1024 / 1024).toFixed(1)} MB`
                        : '暂无缓存数据'}
                    </Text>
                  </View>
                  {clearingCache ? (
                    <ActivityIndicator size="small" color={COLORS.danger} />
                  ) : (
                    <Text style={[styles.settingChevron, { color: COLORS.textMuted }]}>›</Text>
                  )}
                </TouchableOpacity>
              </View>

              {isAdmin && (
                <>
                  <Text style={[styles.sheetSection, { color: COLORS.textMuted }]}>后端设置</Text>
                  <View style={[styles.sheetCard, { backgroundColor: COLORS.card }]}>
                    <BackendSettings colors={COLORS} />
                  </View>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 我的足迹弹框 */}
      <Modal visible={tracksModalVisible} transparent animationType="slide" onRequestClose={() => setTracksModalVisible(false)}>
        <View style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}>
          <View style={[styles.sheetModal, { maxHeight: '85%', backgroundColor: COLORS.card }]}>
            <View style={[styles.sheetHeader, { borderBottomColor: COLORS.divider }]}>
              <Text style={[styles.sheetTitle, { color: COLORS.textPrimary }]}>我的足迹</Text>
              <View style={styles.sheetHeaderRight}>
                {navTracks.length > 0 && (
                  <TouchableOpacity onPress={handleClearTracks} style={styles.sheetHeaderBtn}>
                    <Text style={[styles.sheetHeaderBtnText, { color: COLORS.danger }]}>清空</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => setTracksModalVisible(false)}>
                  <Text style={[styles.sheetClose, { color: COLORS.accent }]}>完成</Text>
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView style={styles.sheetBody}>
              {navTracks.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyIcon}>👣</Text>
                  <Text style={[styles.emptyText, { color: COLORS.textSecondary }]}>暂无足迹记录</Text>
                  <Text style={[styles.emptyHint, { color: COLORS.textMuted }]}>使用导航后会自动保存轨迹</Text>
                </View>
              ) : (
                <>
                  {/* 汇总统计 */}
                  <View style={[styles.sheetCard, { backgroundColor: COLORS.inputBg }]}>
                    <View style={styles.footprintSummary}>
                      <View style={styles.footprintSummaryItem}>
                        <Text style={[styles.footprintSummaryValue, { color: COLORS.accent }]}>
                          {navTracks.length}
                        </Text>
                        <Text style={[styles.footprintSummaryLabel, { color: COLORS.textMuted }]}>轨迹数</Text>
                      </View>
                      <View style={[styles.footprintSummaryDivider, { backgroundColor: COLORS.divider }]} />
                      <View style={styles.footprintSummaryItem}>
                        <Text style={[styles.footprintSummaryValue, { color: COLORS.accent }]}>
                          {formatDistance(navTracks.reduce((sum, t) => sum + (t.distance || 0), 0))}
                        </Text>
                        <Text style={[styles.footprintSummaryLabel, { color: COLORS.textMuted }]}>总里程</Text>
                      </View>
                      <View style={[styles.footprintSummaryDivider, { backgroundColor: COLORS.divider }]} />
                      <View style={styles.footprintSummaryItem}>
                        <Text style={[styles.footprintSummaryValue, { color: COLORS.accent }]}>
                          {formatDuration(navTracks.reduce((sum, t) => sum + (t.duration || 0), 0))}
                        </Text>
                        <Text style={[styles.footprintSummaryLabel, { color: COLORS.textMuted }]}>总时长</Text>
                      </View>
                    </View>
                  </View>

                  {/* 轨迹列表 */}
                  <View style={[styles.sheetCard, { backgroundColor: COLORS.inputBg }]}>
                    {navTracks.map((t, idx) => (
                      <View key={t.id}>
                        <View style={styles.trackItem}>
                          <View style={[styles.trackIndex, { backgroundColor: COLORS.avatarBg }]}>
                            <Text style={styles.trackIndexText}>{idx + 1}</Text>
                          </View>
                          <View style={styles.trackInfo}>
                            <Text style={[styles.trackRoute, { color: COLORS.textPrimary }]}>
                              {t.startName || '起点'} → {t.endName || '终点'}
                            </Text>
                            <Text style={[styles.trackTime, { color: COLORS.textMuted }]}>
                              {new Date(t.startTime).toLocaleString()}
                            </Text>
                            <View style={styles.trackStats}>
                              <Text style={[styles.trackStat, { color: COLORS.textSecondary }]}>📍 {formatDistance(t.distance)}</Text>
                              <Text style={[styles.trackStat, { color: COLORS.textSecondary }]}>⏱ {formatDuration(t.duration)}</Text>
                            </View>
                          </View>
                        </View>
                        {idx < navTracks.length - 1 && <Divider colors={COLORS} />}
                      </View>
                    ))}
                  </View>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 关于弹框 */}
      <Modal visible={aboutModalVisible} transparent animationType="fade" onRequestClose={() => setAboutModalVisible(false)}>
        <TouchableWithoutFeedback onPress={() => setAboutModalVisible(false)}>
          <View style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={[styles.aboutModalContent, { backgroundColor: COLORS.card }]}>
                <Text style={[styles.aboutTitle, { color: COLORS.textPrimary }]}>网优伴侣</Text>
                <Text style={[styles.aboutVersion, { color: COLORS.textMuted }]}>V{Constants.expoConfig?.version || '2.0.0'}</Text>
                <View style={[styles.aboutDivider, { backgroundColor: COLORS.divider }]} />
                <View style={styles.aboutRow}>
                  <Text style={[styles.aboutLabel, { color: COLORS.textMuted }]}>PC端地址</Text>
                  <TouchableOpacity
                    onPress={() => {
                      if (currentApiUrl) {
                        Clipboard.setString(currentApiUrl);
                        ToastAndroid?.show('已复制到剪贴板', ToastAndroid?.SHORT);
                      }
                    }}
                    activeOpacity={0.6}
                  >
                    <Text style={[styles.aboutValue, { color: COLORS.accent, textDecorationLine: 'underline' }]} numberOfLines={1} ellipsizeMode="tail">{currentApiUrl || '—'}</Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.aboutRow}>
                  <Text style={[styles.aboutLabel, { color: COLORS.textMuted }]}>管理员微信</Text>
                  <TouchableOpacity
                    onPress={() => {
                      Clipboard.setString('pengwc2010');
                      ToastAndroid?.show('微信号已复制', ToastAndroid?.SHORT);
                    }}
                    activeOpacity={0.6}
                  >
                    <Text style={[styles.aboutValue, { color: COLORS.accent, textDecorationLine: 'underline' }]}>pengwc2010</Text>
                  </TouchableOpacity>
                </View>
                <View style={[styles.aboutDivider, { backgroundColor: COLORS.divider }]} />
                <TouchableOpacity
                  style={[styles.aboutShareBtn, { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }]}
                  onPress={handleCheckUpdate}
                  disabled={checkingUpdate}
                  activeOpacity={0.7}
                >
                  {checkingUpdate ? (
                    <>
                      <ActivityIndicator size="small" color={COLORS.accent} style={{ marginRight: 8 }} />
                      <Text style={[styles.aboutShareBtnText, { color: COLORS.accent }]}>检查中...</Text>
                    </>
                  ) : (
                    <Text style={[styles.aboutShareBtnText, { color: COLORS.accent }]}>检查更新</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.aboutShareBtn}
                  onPress={() => {
                    Share.share({
                      title: '网优伴侣',
                      message: '网优伴侣 - 网络优化工程师的移动助手\n下载链接：',  // TODO: 待PC端开放下载链接后补充
                    });
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.aboutShareBtnText, { color: COLORS.accent }]}>分享给好友</Text>
                </TouchableOpacity>
                <Text style={[styles.aboutCopyright, { color: COLORS.textMuted }]}>© 2026 pengwc.asia</Text>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* 下载进度弹框 */}
      <Modal visible={downloadModalVisible} transparent animationType="fade" onRequestClose={() => {
        // 下载中不允许关闭，避免半成品文件
        if (downloadPhase === 'downloading' || downloadPhase === 'installing') return;
        setDownloadModalVisible(false);
      }}>
        <TouchableWithoutFeedback onPress={() => {
          if (downloadPhase !== 'downloading' && downloadPhase !== 'installing') {
            setDownloadModalVisible(false);
          }
        }}>
          <View style={[styles.modalOverlay, { backgroundColor: COLORS.overlayBg }]}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={[styles.aboutModalContent, { backgroundColor: COLORS.card, padding: 24 }]}>
                {downloadPhase === 'downloading' && (
                  <>
                    <Text style={[styles.aboutTitle, { color: COLORS.textPrimary, fontSize: 18, marginBottom: 8 }]}>正在下载更新</Text>
                    <Text style={[styles.aboutVersion, { color: COLORS.textMuted, marginBottom: 20 }]}>
                      {downloadPercent > 0 ? `${downloadPercent.toFixed(1)}%` : '准备中...'}
                    </Text>
                    <View style={[styles.progressBarBg, { backgroundColor: COLORS.inputBg }]}>
                      <View
                        style={{
                          width: `${Math.min(100, downloadPercent)}%`,
                          height: '100%',
                          backgroundColor: COLORS.accent,
                          borderRadius: 4,
                        }}
                      />
                    </View>
                    <Text style={[styles.aboutVersion, { color: COLORS.textMuted, fontSize: 12, marginTop: 12 }]}>
                      {formatBytes(downloadedBytes)} / {totalBytes > 0 ? formatBytes(totalBytes) : '?'}
                    </Text>
                    <Text style={[styles.aboutVersion, { color: COLORS.textMuted, fontSize: 12, marginTop: 8 }]}>
                      优先走 Tailscale 直连，绕过 CF Tunnel 限速
                    </Text>
                  </>
                )}
                {downloadPhase === 'installing' && (
                  <>
                    <Text style={[styles.aboutTitle, { color: COLORS.textPrimary, fontSize: 18, marginBottom: 16 }]}>下载完成</Text>
                    <ActivityIndicator size="large" color={COLORS.accent} style={{ marginBottom: 16 }} />
                    <Text style={[styles.aboutVersion, { color: COLORS.textMuted }]}>正在调起安装器...</Text>
                  </>
                )}
                {downloadPhase === 'done' && (
                  <>
                    <Text style={[styles.aboutTitle, { color: COLORS.textPrimary, fontSize: 18, marginBottom: 16 }]}>下载完成</Text>
                    <Text style={[styles.aboutVersion, { color: COLORS.success }]}>✓ 请在系统安装器中完成安装</Text>
                    <TouchableOpacity
                      style={[styles.aboutShareBtn, { marginTop: 16 }]}
                      onPress={() => setDownloadModalVisible(false)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.aboutShareBtnText, { color: COLORS.accent }]}>关闭</Text>
                    </TouchableOpacity>
                  </>
                )}
                {downloadPhase === 'error' && (
                  <>
                    <Text style={[styles.aboutTitle, { color: COLORS.textPrimary, fontSize: 18, marginBottom: 16 }]}>下载失败</Text>
                    <Text style={[styles.aboutVersion, { color: COLORS.danger }]}>请尝试使用浏览器下载</Text>
                    <TouchableOpacity
                      style={[styles.aboutShareBtn, { marginTop: 16 }]}
                      onPress={() => setDownloadModalVisible(false)}
                      activeOpacity={0.7}
                    >
                      <Text style={[styles.aboutShareBtnText, { color: COLORS.accent }]}>关闭</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </View>
  );
}

/** 字节数格式化 */
function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// ==================== 内部组件 ====================

function SettingRow({ icon, title, subtitle, onPress, colors, iconColor }: {
  icon: React.ReactNode; title: string; subtitle?: string; onPress: () => void;
  colors: AppColors; iconColor?: string;
}) {
  return (
    <TouchableOpacity style={styles.settingRow} onPress={onPress} activeOpacity={0.6}>
      <View style={[styles.settingIcon, { backgroundColor: colors.bg }]}>
        {typeof icon === 'string' ? (
          <Text style={[styles.settingIconText, { color: iconColor || colors.textPrimary }]}>{icon}</Text>
        ) : (
          icon
        )}
      </View>
      <View style={styles.settingTextBlock}>
        <Text style={[styles.settingTitle, { color: colors.textPrimary }]}>{title}</Text>
        {subtitle && <Text style={[styles.settingSubtitle, { color: colors.textMuted }]}>{subtitle}</Text>}
      </View>
      <Text style={[styles.settingChevron, { color: colors.textMuted }]}>›</Text>
    </TouchableOpacity>
  );
}

/** 我的足迹图标：用 View 自绘脚印（避免 emoji 字体强制彩色），支持任意 color */
const FootprintIcon = ({ color, size = 18 }: { color: string; size?: number }) => {
  // 脚掌（纵向圆角椭圆）
  const soleW = size * 0.5;
  const soleH = size * 0.55;
  // 脚趾（4 个小圆，从大到小排列在大脚趾侧）
  const toe1Size = size * 0.22;
  const toe2Size = size * 0.17;
  const toe3Size = size * 0.15;
  const toe4Size = size * 0.13;
  const toeY = size * 0.05;
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'flex-start' }}>
      <View
        style={{
          position: 'absolute',
          left: size * 0.5 - toe1Size / 2 - size * 0.18,
          top: toeY,
          width: toe1Size, height: toe1Size,
          borderRadius: toe1Size / 2, backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: size * 0.5 - toe2Size / 2 - size * 0.04,
          top: toeY + size * 0.02,
          width: toe2Size, height: toe2Size,
          borderRadius: toe2Size / 2, backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: size * 0.5 - toe3Size / 2 + size * 0.10,
          top: toeY + size * 0.06,
          width: toe3Size, height: toe3Size,
          borderRadius: toe3Size / 2, backgroundColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: size * 0.5 - toe4Size / 2 + size * 0.22,
          top: toeY + size * 0.12,
          width: toe4Size, height: toe4Size,
          borderRadius: toe4Size / 2, backgroundColor: color,
        }}
      />
      <View
        style={{
          width: soleW, height: soleH,
          borderRadius: soleW / 2, backgroundColor: color,
          marginTop: size * 0.30,
        }}
      />
    </View>
  );
};

function SettingSwitchRow({ title, subtitle, value, onValueChange, trackFalseColor, colors }: {
  title: string; subtitle?: string; value: boolean; onValueChange: (v: boolean) => void;
  trackFalseColor?: string; colors: AppColors;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingTextBlock}>
        <Text style={[styles.settingTitle, { color: colors.textPrimary }]}>{title}</Text>
        {subtitle && <Text style={[styles.settingSubtitle, { color: colors.textMuted }]}>{subtitle}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: trackFalseColor || '#E0E0E0', true: colors.accent }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}

function Divider({ colors }: { colors: AppColors }) {
  return <View style={[styles.divider, { backgroundColor: colors.divider }]} />;
}

// 后端设置组件
const PRESET_URLS = {
  default: 'https://app.pengwc.asia',
  alternate: 'https://armbian.tail362392.ts.net',
} as const;

function BackendSettings({ colors }: { colors: AppColors }) {
  const [currentUrl, setCurrentUrl] = useState('');
  const [inputUrl, setInputUrl] = useState('');
  const [status, setStatus] = useState<'checking' | 'connected' | 'disconnected'>('checking');
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);

  const statusColors = {
    checking: { color: colors.textMuted, label: '检测中' },
    connected: { color: colors.success, label: '已连接' },
    disconnected: { color: colors.danger, label: '未连接' },
  };
  const statusInfo = statusColors[status];

  const refreshStatus = useCallback(async () => {
    const url = await apiService.getCurrentBaseUrl();
    setCurrentUrl(url);
    setInputUrl(url);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
  }, []);

  useEffect(() => { refreshStatus(); }, [refreshStatus]);

  const handleTest = async () => {
    const url = inputUrl.trim().replace(/\/+$/, '');
    if (!url) { Alert.alert('提示', '请输入后端地址'); return; }
    setTesting(true);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
    setTesting(false);
    Alert.alert(result.ok ? '连接成功' : '连接失败', result.message);
  };

  const handleSave = async () => {
    const url = inputUrl.trim().replace(/\/+$/, '');
    if (!url) { Alert.alert('提示', '请输入后端地址'); return; }
    setSaving(true);
    await apiService.updateApiUrl(url);
    setCurrentUrl(url);
    setSaving(false);
    setTesting(true);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
    setTesting(false);
    Alert.alert('已保存', result.ok ? '后端地址已更新，连接正常' : '地址已保存，但连接失败');
  };

  const handleReset = async () => {
    await apiService.resetApiUrl();
    refreshStatus();
    Alert.alert('已重置', '后端地址将使用自动发现模式');
  };

  const handlePresetSwitch = async (url: string) => {
    setInputUrl(url);
    setSaving(true);
    await apiService.updateApiUrl(url);
    setCurrentUrl(url);
    setSaving(false);
    setTesting(true);
    setStatus('checking');
    const result = await apiService.testConnection(url);
    setStatus(result.ok ? 'connected' : 'disconnected');
    setTesting(false);
    Alert.alert('已切换', result.ok ? '后端地址已切换，连接正常' : '地址已切换，但连接失败');
  };

  return (
    <View style={{ paddingHorizontal: 12, paddingVertical: 8 }}>
      {/* 状态指示 */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: statusInfo.color, marginRight: 8 }} />
        <Text style={{ fontSize: 12, fontWeight: '500', color: colors.textPrimary, marginRight: 8 }}>{statusInfo.label}</Text>
        <Text style={{ fontSize: 11, color: colors.textMuted, flex: 1 }} numberOfLines={1}>{currentUrl || '—'}</Text>
      </View>

      {/* 预设地址 */}
      <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6, fontWeight: '500' }}>预设</Text>
      <View style={{ flexDirection: 'row', gap: 8, marginBottom: 12 }}>
        {[{ key: 'default', title: '默认', url: PRESET_URLS.default }, { key: 'alternate', title: '备用', url: PRESET_URLS.alternate }].map(p => (
          <TouchableOpacity
            key={p.key}
            style={{
              flex: 1, paddingVertical: 8, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1,
              borderColor: currentUrl === p.url ? colors.accent : colors.cardBorder,
              backgroundColor: currentUrl === p.url ? (colors.accent + '15') : colors.inputBg,
              alignItems: 'center',
            }}
            onPress={() => handlePresetSwitch(p.url)}
            disabled={saving || testing}
            activeOpacity={0.7}
          >
            <Text style={{ fontSize: 11, fontWeight: '600', color: currentUrl === p.url ? colors.accent : colors.textSecondary, marginBottom: 2 }}>{p.title}</Text>
            <Text style={{ fontSize: 9, color: colors.textMuted }} numberOfLines={1}>{p.url}</Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* 自定义地址 */}
      <Text style={{ fontSize: 11, color: colors.textMuted, marginBottom: 6, fontWeight: '500' }}>自定义</Text>
      <TextInput
        style={{ borderWidth: 1, borderColor: colors.cardBorder, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 8, fontSize: 12, color: colors.textPrimary, backgroundColor: colors.inputBg, marginBottom: 10, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}
        value={inputUrl}
        onChangeText={setInputUrl}
        placeholder="输入后端地址"
        placeholderTextColor={colors.textMuted}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
      />

      {/* 按钮 */}
      <View style={{ flexDirection: 'row', gap: 10, marginBottom: 8 }}>
        <TouchableOpacity
          style={{ flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.inputBg, borderWidth: 1, borderColor: colors.cardBorder }}
          onPress={handleTest}
          disabled={testing}
          activeOpacity={0.7}
        >
          {testing ? <ActivityIndicator color={colors.textPrimary} size="small" /> : <Text style={{ fontSize: 13, fontWeight: '500', color: colors.textPrimary }}>测试</Text>}
        </TouchableOpacity>
        <TouchableOpacity
          style={{ flex: 1, paddingVertical: 9, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accent }}
          onPress={handleSave}
          disabled={saving || testing}
          activeOpacity={0.7}
        >
          {saving ? <ActivityIndicator color="#fff" size="small" /> : <Text style={{ fontSize: 13, fontWeight: '600', color: '#fff' }}>保存</Text>}
        </TouchableOpacity>
      </View>

      <TouchableOpacity onPress={handleReset} hitSlop={{ top: 8, bottom: 8 }} style={{ alignItems: 'center', paddingVertical: 4 }}>
        <Text style={{ fontSize: 12, color: colors.textMuted }}>重置为自动发现</Text>
      </TouchableOpacity>
    </View>
  );
}

// ==================== 样式 ====================

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },

  header: {
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16,
  },
  title: {
    fontSize: 28, fontWeight: '700',
    letterSpacing: -0.4,
  },

  // 用户卡片
  userCard: {
    flexDirection: 'row', alignItems: 'center',
    marginHorizontal: 16, marginBottom: 16,
    padding: 16, borderRadius: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 2, elevation: 1,
  },
  avatarWrap: { marginRight: 14 },
  avatar: {
    width: 56, height: 56, borderRadius: 28,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: {
    color: '#fff', fontSize: 22, fontWeight: '700',
  },
  userInfo: { flex: 1 },
  userName: {
    fontSize: 16, fontWeight: '600', marginBottom: 4,
  },
  userEmail: { fontSize: 12 },
  loginBtn: {
    paddingHorizontal: 18, paddingVertical: 8,
    borderRadius: 6,
  },
  loginBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  logoutBtn: {
    borderWidth: 1,
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6,
  },
  logoutBtnText: { fontSize: 12, fontWeight: '600' },

  // 设置项卡片
  card: {
    marginHorizontal: 16, marginBottom: 16,
    borderRadius: 10, paddingHorizontal: 4,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 2, elevation: 1,
  },
  settingRow: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingVertical: 14,
  },
  settingIcon: {
    width: 32, height: 32, borderRadius: 6,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 12,
  },
  settingIconText: { fontSize: 16 },
  settingTextBlock: { flex: 1 },
  settingTitle: { fontSize: 15, fontWeight: '500' },
  settingSubtitle: { fontSize: 11, marginTop: 2 },
  settingChevron: { fontSize: 18, marginLeft: 8 },
  divider: { height: StyleSheet.hairlineWidth, marginLeft: 56 },

  // 登录弹框
  modalOverlay: {
    flex: 1,
    justifyContent: 'center', alignItems: 'center',
  },
  loginModalContent: {
    borderRadius: 12, padding: 20,
    width: '85%', maxWidth: 360,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, shadowRadius: 8, elevation: 10,
  },
  loginModalTitle: {
    fontSize: 18, fontWeight: '700',
    textAlign: 'center', marginBottom: 4,
  },
  loginModalSubtitle: {
    fontSize: 12, textAlign: 'center', marginBottom: 18,
  },
  loginInput: {
    borderWidth: 1, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
    marginBottom: 12,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },
  loginInputValue: { fontSize: 15, flex: 1 },
  loginInputPlaceholder: { fontSize: 15, flex: 1 },
  loginInputChevron: { fontSize: 14, marginLeft: 8 },
  loginModalActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  loginModalBtn: { flex: 1, paddingVertical: 11, borderRadius: 6, alignItems: 'center' },
  loginModalBtnGhost: {
    borderWidth: 1,
  },
  loginModalBtnGhostText: { fontSize: 14, fontWeight: '600' },
  loginModalBtnPrimary: {},
  loginModalBtnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  // 登录/注册弹框底部入口
  registerEntry: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    marginTop: 16,
  },
  registerEntryText: { fontSize: 13 },
  registerEntryLink: { fontSize: 13, fontWeight: '600' },
  // 运营商选择器（底部弹层）
  operatorSheet: {
    borderTopLeftRadius: 14, borderTopRightRadius: 14,
    paddingBottom: 24,
  },
  operatorSheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 16, paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  operatorSheetTitle: { fontSize: 15, fontWeight: '600' },
  operatorSheetClose: { fontSize: 22, lineHeight: 22, paddingHorizontal: 4 },
  operatorItem: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingVertical: 14, paddingHorizontal: 20,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  operatorItemText: { fontSize: 15 },
  operatorItemCheck: { fontSize: 16, fontWeight: '600' },

  // 底部弹窗(sheet)
  sheetModal: {
    borderTopLeftRadius: 14, borderTopRightRadius: 14,
    width: '100%', position: 'absolute', bottom: 0,
    maxHeight: '90%',
  },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  sheetTitle: { fontSize: 17, fontWeight: '600' },
  sheetClose: { fontSize: 15, fontWeight: '500' },
  sheetHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  sheetHeaderBtn: { paddingVertical: 2, paddingHorizontal: 4 },
  sheetHeaderBtnText: { fontSize: 14, fontWeight: '500' },
  sheetBody: { paddingBottom: 32 },
  sheetSection: {
    fontSize: 11, letterSpacing: 1,
    textTransform: 'uppercase', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8,
    fontWeight: '600',
  },
  sheetCard: {
    marginHorizontal: 16, borderRadius: 10,
    paddingHorizontal: 4,
  },

  // 空状态
  emptyContainer: {
    alignItems: 'center', paddingVertical: 60,
  },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyText: { fontSize: 15, marginBottom: 6 },
  emptyHint: { fontSize: 12 },

  // 导航记录项
  trackItem: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  trackIndex: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  trackIndexText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  trackInfo: { flex: 1 },
  trackRoute: { fontSize: 14, fontWeight: '500', marginBottom: 2 },
  trackTime: { fontSize: 11, marginBottom: 6 },
  trackStats: { flexDirection: 'row', gap: 14 },
  trackStat: { fontSize: 12 },

  // 我的足迹汇总
  footprintSummary: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 16,
  },
  footprintSummaryItem: {
    flex: 1,
    alignItems: 'center',
  },
  footprintSummaryValue: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 4,
  },
  footprintSummaryLabel: {
    fontSize: 11,
    fontWeight: '500',
  },
  footprintSummaryDivider: {
    width: StyleSheet.hairlineWidth,
    height: 28,
  },

  // 关于弹框
  aboutModalContent: {
    borderRadius: 12, padding: 24,
    width: '85%', maxWidth: 360,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, shadowRadius: 8, elevation: 10,
  },
  aboutTitle: {
    fontSize: 20, fontWeight: '700',
    textAlign: 'center',
  },
  aboutVersion: {
    fontSize: 12, textAlign: 'center', marginTop: 4,
  },
  aboutDivider: { height: StyleSheet.hairlineWidth, marginVertical: 16 },
  aboutRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  aboutLabel: { fontSize: 13 },
  aboutValue: { fontSize: 13, flex: 1, textAlign: 'right' },
  aboutShareBtn: {
    paddingVertical: 10, alignItems: 'center',
  },
  aboutShareBtnText: { fontSize: 14, fontWeight: '600' },
  aboutCopyright: {
    fontSize: 11, textAlign: 'center', marginTop: 12,
  },
  progressBarBg: {
    height: 8,
    borderRadius: 4,
    overflow: 'hidden',
  },
});
