import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, StyleSheet, ScrollView, TouchableOpacity, Alert,
  TextInput, Modal, ActivityIndicator, Switch, Platform,
} from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system';
import { shareAsync } from 'expo-sharing';
import { apiService } from '../../src/services/api';
import {
  isNewerVersion, shouldCheckVersion, markVersionChecked,
} from '../../src/services/versionCheckService';

// 配色方案：与 favorites.tsx 保持一致（白底卡片 + 淡灰背景）
const COLORS = {
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
} as const;

// 本地用户信息键
const STORAGE_KEYS = {
  userInfo: '@profile_user_info',
  appSettings: '@profile_app_settings',
  navTracks: '@profile_nav_tracks',
};

// 模拟导航轨迹项（本地存储，后续对接后端）
interface NavTrackItem {
  id: string;
  startTime: number;
  endTime: number;
  distance: number;       // 米
  duration: number;       // 秒
  startName?: string;
  endName?: string;
}

export default function ProfileScreen() {
  const insets = useSafeAreaInsets();

  // 用户状态
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [userInfo, setUserInfo] = useState<{
    username: string; email: string; avatar: string;
  } | null>(null);
  const [loginModalVisible, setLoginModalVisible] = useState(false);
  const [loginUsername, setLoginUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);
  const [currentApiUrl, setCurrentApiUrl] = useState('');

  // 注册状态
  const [registerModalVisible, setRegisterModalVisible] = useState(false);
  const [regUsername, setRegUsername] = useState('');
  const [regEmail, setRegEmail] = useState('');
  const [regPassword, setRegPassword] = useState('');
  const [regPasswordConfirm, setRegPasswordConfirm] = useState('');
  const [regLoading, setRegLoading] = useState(false);

  // 应用设置
  const [darkMode, setDarkMode] = useState(false);
  const [autoSync, setAutoSync] = useState(true);
  const [ttsEnabled, setTtsEnabled] = useState(true);

  // 导航轨迹
  const [navTracks, setNavTracks] = useState<NavTrackItem[]>([]);

  // 版本检查
  const [updateInfo, setUpdateInfo] = useState<{
    id: number; version: string; changelog?: string;
  } | null>(null);
  const [updateModalVisible, setUpdateModalVisible] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const checkingRef = useRef(false);

  // 子页面 modal
  const [aboutModalVisible, setAboutModalVisible] = useState(false);
  const [tracksModalVisible, setTracksModalVisible] = useState(false);
  const [appSettingsModalVisible, setAppSettingsModalVisible] = useState(false);

  // 加载本地数据
  useEffect(() => {
    (async () => {
      try {
        const u = await AsyncStorage.getItem(STORAGE_KEYS.userInfo);
        if (u) {
          setUserInfo(JSON.parse(u));
          setIsLoggedIn(true);
        }
        const s = await AsyncStorage.getItem(STORAGE_KEYS.appSettings);
        if (s) {
          const settings = JSON.parse(s);
          setDarkMode(settings.darkMode ?? false);
          setAutoSync(settings.autoSync ?? true);
          setTtsEnabled(settings.ttsEnabled ?? true);
        }
        const t = await AsyncStorage.getItem(STORAGE_KEYS.navTracks);
        if (t) setNavTracks(JSON.parse(t));
      } catch (e) {
        console.warn('[Profile] load local data failed', e);
      }
      const url = await apiService.getCurrentBaseUrl();
      setCurrentApiUrl(url);

      // 自动检查版本更新
      try {
        const shouldCheck = await shouldCheckVersion();
        if (shouldCheck && !checkingRef.current) {
          checkingRef.current = true;
          const latest = await apiService.checkAppVersion();
          if (latest && isNewerVersion(latest.version, '1.0.0')) {
            setUpdateInfo({ id: latest.id, version: latest.version, changelog: latest.changelog });
            setUpdateModalVisible(true);
          }
          await markVersionChecked();
          checkingRef.current = false;
        }
      } catch (e) {
        console.log('[Profile] version check failed:', e);
        checkingRef.current = false;
      }
    })();
  }, []);

  // 登录（前端校验占位，后续对接后端用户管理接口）
  const handleLogin = useCallback(async () => {
    const username = loginUsername.trim();
    const password = loginPassword;
    if (!username || !password) {
      Alert.alert('提示', '请输入用户名和密码');
      return;
    }
    setLoginLoading(true);
    try {
      // TODO: 替换为真实后端登录接口
      // POST {currentApiUrl}/api/v1/auth/login
      // 当前为前端模拟登录
      await new Promise(r => setTimeout(r, 600));
      const mockUser = {
        username,
        email: `${username}@pengwc.asia`,
        avatar: username.substring(0, 1).toUpperCase(),
      };
      setUserInfo(mockUser);
      setIsLoggedIn(true);
      await AsyncStorage.setItem(STORAGE_KEYS.userInfo, JSON.stringify(mockUser));
      setLoginModalVisible(false);
      setLoginUsername('');
      setLoginPassword('');
      Alert.alert('登录成功', `欢迎，${username}`);
    } catch (e: any) {
      Alert.alert('登录失败', e.message || '请稍后重试');
    } finally {
      setLoginLoading(false);
    }
  }, [loginUsername, loginPassword]);

  // 注册（前端校验占位，后续对接后端用户管理接口）
  const handleRegister = useCallback(async () => {
    const username = regUsername.trim();
    const email = regEmail.trim();
    const password = regPassword;
    const passwordConfirm = regPasswordConfirm;
    if (!username) { Alert.alert('提示', '请输入用户名'); return; }
    if (username.length < 3) { Alert.alert('提示', '用户名至少 3 个字符'); return; }
    if (!email) { Alert.alert('提示', '请输入邮箱'); return; }
    if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(email)) { Alert.alert('提示', '邮箱格式不正确'); return; }
    if (!password) { Alert.alert('提示', '请输入密码'); return; }
    if (password.length < 6) { Alert.alert('提示', '密码至少 6 个字符'); return; }
    if (password !== passwordConfirm) { Alert.alert('提示', '两次输入的密码不一致'); return; }
    setRegLoading(true);
    try {
      // TODO: 替换为真实后端注册接口
      // POST {currentApiUrl}/api/v1/auth/register
      // body: { username, email, password }
      // 当前为前端模拟注册
      await new Promise(r => setTimeout(r, 800));
      const mockUser = {
        username,
        email,
        avatar: username.substring(0, 1).toUpperCase(),
      };
      setUserInfo(mockUser);
      setIsLoggedIn(true);
      await AsyncStorage.setItem(STORAGE_KEYS.userInfo, JSON.stringify(mockUser));
      setRegisterModalVisible(false);
      setRegUsername('');
      setRegEmail('');
      setRegPassword('');
      setRegPasswordConfirm('');
      Alert.alert('注册成功', `欢迎加入，${username}`);
    } catch (e: any) {
      Alert.alert('注册失败', e.message || '请稍后重试');
    } finally {
      setRegLoading(false);
    }
  }, [regUsername, regEmail, regPassword, regPasswordConfirm]);

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
    setRegEmail('');
    setRegPassword('');
    setRegPasswordConfirm('');
  }, []);

  // 退出登录
  const handleLogout = useCallback(() => {
    Alert.alert('退出确认', '确定要退出登录吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '退出', style: 'destructive', onPress: async () => {
          setIsLoggedIn(false);
          setUserInfo(null);
          await AsyncStorage.removeItem(STORAGE_KEYS.userInfo);
        },
      },
    ]);
  }, []);

  // ==================== 版本检查 ====================

  const handleCheckUpdate = useCallback(async () => {
    if (checkingUpdate) return;
    setCheckingUpdate(true);
    try {
      const latest = await apiService.checkAppVersion();
      if (!latest) {
        Alert.alert('检查更新', '当前已是最新版本');
        return;
      }
      if (isNewerVersion(latest.version, '1.0.0')) {
        setUpdateInfo({ id: latest.id, version: latest.version, changelog: latest.changelog });
        setUpdateModalVisible(true);
      } else {
        Alert.alert('检查更新', '当前已是最新版本');
      }
    } catch (e: any) {
      Alert.alert('检查失败', e.message || '无法连接到服务器');
    } finally {
      setCheckingUpdate(false);
    }
  }, [checkingUpdate]);

  const handleDownloadUpdate = useCallback(async () => {
    if (!updateInfo || downloading) return;
    setDownloading(true);
    setDownloadProgress(0);
    try {
      const baseUrl = await apiService.getCurrentBaseUrl();
      const downloadUrl = `${baseUrl}/api/v1/app-versions/download/${updateInfo.id}`;
      const localUri = FileSystem.cacheDirectory + `npt-update-${updateInfo.version}.apk`;

      const result = await FileSystem.downloadAsync(downloadUrl, localUri);

      if (result && result.uri) {
        setDownloading(false);
        setUpdateModalVisible(false);
        // 调用系统安装器
        await shareAsync(result.uri, {
          mimeType: 'application/vnd.android.package-archive',
        });
      }
    } catch (e: any) {
      Alert.alert('下载失败', e.message || '请稍后重试');
      setDownloading(false);
      setDownloadProgress(0);
    }
  }, [updateInfo, downloading]);

  // 保存应用设置
  const saveAppSettings = useCallback(async (next: {
    darkMode: boolean; autoSync: boolean; ttsEnabled: boolean;
  }) => {
    await AsyncStorage.setItem(STORAGE_KEYS.appSettings, JSON.stringify(next));
  }, []);

  const handleToggleDarkMode = (v: boolean) => {
    setDarkMode(v);
    saveAppSettings({ darkMode: v, autoSync, ttsEnabled });
  };
  const handleToggleAutoSync = (v: boolean) => {
    setAutoSync(v);
    saveAppSettings({ darkMode, autoSync: v, ttsEnabled });
  };
  const handleToggleTts = (v: boolean) => {
    setTtsEnabled(v);
    saveAppSettings({ darkMode, autoSync, ttsEnabled: v });
  };

  // 导航轨迹 - 清空
  const handleClearTracks = useCallback(() => {
    if (navTracks.length === 0) return;
    Alert.alert('清空确认', '确定要清空所有导航轨迹吗？', [
      { text: '取消', style: 'cancel' },
      {
        text: '清空', style: 'destructive', onPress: async () => {
          setNavTracks([]);
          await AsyncStorage.removeItem(STORAGE_KEYS.navTracks);
        },
      },
    ]);
  }, [navTracks.length]);

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
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <StatusBar style="dark" />

      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* 顶部标题 */}
        <View style={styles.header}>
          <Text style={styles.title}>我的</Text>
        </View>

        {/* 用户卡片 */}
        <View style={styles.userCard}>
          <View style={styles.avatarWrap}>
            <View style={styles.avatar}>
              <Text style={styles.avatarText}>
                {isLoggedIn ? (userInfo?.avatar || 'U') : '访'}
              </Text>
            </View>
          </View>
          <View style={styles.userInfo}>
            {isLoggedIn ? (
              <>
                <Text style={styles.userName}>{userInfo?.username}</Text>
                <Text style={styles.userEmail}>{userInfo?.email}</Text>
              </>
            ) : (
              <>
                <Text style={styles.userName}>未登录</Text>
                <Text style={styles.userEmail}>登录后同步数据</Text>
              </>
            )}
          </View>
          {isLoggedIn ? (
            <TouchableOpacity style={styles.logoutBtn} onPress={handleLogout}>
              <Text style={styles.logoutBtnText}>退出</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              style={styles.loginBtn}
              onPress={() => setLoginModalVisible(true)}
            >
              <Text style={styles.loginBtnText}>登录</Text>
            </TouchableOpacity>
          )}
        </View>

        {/* 应用设置入口 */}
        <View style={styles.card}>
          <SettingRow
            icon="◐" title="个性设置" subtitle="主题、显示等"
            onPress={() => setAppSettingsModalVisible(true)}
          />
          <Divider />
          <SettingRow
            icon="⊟" title="应用设置" subtitle={`自动同步 ${autoSync ? '开' : '关'} · 语音播报 ${ttsEnabled ? '开' : '关'}`}
            onPress={() => setAppSettingsModalVisible(true)}
          />
          <Divider />
          <SettingRow
            icon="⏱" title="导航轨迹" subtitle={navTracks.length > 0 ? `${navTracks.length} 条记录` : '暂无记录'}
            onPress={() => setTracksModalVisible(true)}
          />
        </View>

        {/* 检查更新 */}
        <View style={styles.card}>
          <TouchableOpacity
            style={styles.settingRow}
            onPress={handleCheckUpdate}
            activeOpacity={0.6}
            disabled={checkingUpdate}
          >
            <View style={styles.settingIcon}>
              <Text style={styles.settingIconText}>📦</Text>
            </View>
            <View style={styles.settingContent}>
              <Text style={styles.settingTitle}>{checkingUpdate ? '检查中...' : '检查更新'}</Text>
              <Text style={styles.settingSubtitle}>检查 APP 新版本</Text>
            </View>
          </TouchableOpacity>
        </View>

        {/* 关于 */}
        <View style={styles.card}>
          <SettingRow
            icon="ⓘ" title="关于" subtitle="版本与服务信息"
            onPress={() => setAboutModalVisible(true)}
          />
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>

      {/* 登录弹框 */}
      <Modal visible={loginModalVisible} transparent animationType="fade" onRequestClose={() => setLoginModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.loginModalContent}>
            <Text style={styles.loginModalTitle}>登录账号</Text>
            <Text style={styles.loginModalSubtitle}>登录后将同步您的数据到云端</Text>
            <TextInput
              style={styles.loginInput}
              value={loginUsername}
              onChangeText={setLoginUsername}
              placeholder="用户名"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <TextInput
              style={styles.loginInput}
              value={loginPassword}
              onChangeText={setLoginPassword}
              placeholder="密码"
              secureTextEntry
            />
            <View style={styles.loginModalActions}>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnGhost]}
                onPress={() => { setLoginModalVisible(false); setLoginUsername(''); setLoginPassword(''); }}
                disabled={loginLoading}
              >
                <Text style={styles.loginModalBtnGhostText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnPrimary]}
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
              <Text style={styles.registerEntryText}>还没有账号？</Text>
              <TouchableOpacity onPress={openRegister} disabled={loginLoading} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={styles.registerEntryLink}>立即注册</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 注册弹框 */}
      <Modal visible={registerModalVisible} transparent animationType="fade" onRequestClose={closeRegister}>
        <View style={styles.modalOverlay}>
          <View style={styles.loginModalContent}>
            <Text style={styles.loginModalTitle}>注册账号</Text>
            <Text style={styles.loginModalSubtitle}>注册后即可同步数据到云端</Text>
            <TextInput
              style={styles.loginInput}
              value={regUsername}
              onChangeText={setRegUsername}
              placeholder="用户名（至少 3 个字符）"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <TextInput
              style={styles.loginInput}
              value={regEmail}
              onChangeText={setRegEmail}
              placeholder="邮箱"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
            />
            <TextInput
              style={styles.loginInput}
              value={regPassword}
              onChangeText={setRegPassword}
              placeholder="密码（至少 6 个字符）"
              secureTextEntry
            />
            <TextInput
              style={styles.loginInput}
              value={regPasswordConfirm}
              onChangeText={setRegPasswordConfirm}
              placeholder="确认密码"
              secureTextEntry
            />
            <View style={styles.loginModalActions}>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnGhost]}
                onPress={closeRegister}
                disabled={regLoading}
              >
                <Text style={styles.loginModalBtnGhostText}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnPrimary]}
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
              <Text style={styles.registerEntryText}>已有账号？</Text>
              <TouchableOpacity onPress={() => { closeRegister(); setLoginModalVisible(true); }} disabled={regLoading} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={styles.registerEntryLink}>返回登录</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 个性/应用设置弹框 */}
      <Modal visible={appSettingsModalVisible} transparent animationType="slide" onRequestClose={() => setAppSettingsModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.sheetModal, { maxHeight: '80%' }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>设置</Text>
              <TouchableOpacity onPress={() => setAppSettingsModalVisible(false)}>
                <Text style={styles.sheetClose}>完成</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.sheetBody}>
              <Text style={styles.sheetSection}>个性设置</Text>
              <View style={styles.sheetCard}>
                <SettingSwitchRow
                  title="深色模式"
                  subtitle="切换应用主题（占位）"
                  value={darkMode}
                  onValueChange={handleToggleDarkMode}
                />
              </View>

              <Text style={styles.sheetSection}>应用设置</Text>
              <View style={styles.sheetCard}>
                <SettingSwitchRow
                  title="自动同步"
                  subtitle="启动时自动同步最新工参"
                  value={autoSync}
                  onValueChange={handleToggleAutoSync}
                />
                <Divider />
                <SettingSwitchRow
                  title="语音播报"
                  subtitle="导航过程中播报转向"
                  value={ttsEnabled}
                  onValueChange={handleToggleTts}
                />
              </View>
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 导航轨迹弹框 */}
      <Modal visible={tracksModalVisible} transparent animationType="slide" onRequestClose={() => setTracksModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.sheetModal, { maxHeight: '85%' }]}>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>导航轨迹</Text>
              <View style={styles.sheetHeaderRight}>
                {navTracks.length > 0 && (
                  <TouchableOpacity onPress={handleClearTracks} style={styles.sheetHeaderBtn}>
                    <Text style={styles.sheetHeaderBtnText}>清空</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => setTracksModalVisible(false)}>
                  <Text style={styles.sheetClose}>完成</Text>
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView style={styles.sheetBody}>
              {navTracks.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyIcon}>⏱</Text>
                  <Text style={styles.emptyText}>暂无导航记录</Text>
                  <Text style={styles.emptyHint}>使用导航后会自动保存轨迹</Text>
                </View>
              ) : (
                <View style={styles.sheetCard}>
                  {navTracks.map((t, idx) => (
                    <View key={t.id}>
                      <View style={styles.trackItem}>
                        <View style={styles.trackIndex}>
                          <Text style={styles.trackIndexText}>{idx + 1}</Text>
                        </View>
                        <View style={styles.trackInfo}>
                          <Text style={styles.trackRoute}>
                            {t.startName || '起点'} → {t.endName || '终点'}
                          </Text>
                          <Text style={styles.trackTime}>
                            {new Date(t.startTime).toLocaleString()}
                          </Text>
                          <View style={styles.trackStats}>
                            <Text style={styles.trackStat}>📍 {formatDistance(t.distance)}</Text>
                            <Text style={styles.trackStat}>⏱ {formatDuration(t.duration)}</Text>
                          </View>
                        </View>
                      </View>
                      {idx < navTracks.length - 1 && <Divider />}
                    </View>
                  ))}
                </View>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 关于弹框 */}
      <Modal visible={aboutModalVisible} transparent animationType="fade" onRequestClose={() => setAboutModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.aboutModalContent}>
            <Text style={styles.aboutTitle}>工参地图</Text>
            <Text style={styles.aboutVersion}>版本 1.0.0</Text>
            <View style={styles.aboutDivider} />
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>后端服务</Text>
              <Text style={styles.aboutValue} numberOfLines={1}>{currentApiUrl || '—'}</Text>
            </View>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>API 前缀</Text>
              <Text style={styles.aboutValue}>/api/v1</Text>
            </View>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>地图 SDK</Text>
              <Text style={styles.aboutValue}>高德地图 (AMap)</Text>
            </View>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>定位 SDK</Text>
              <Text style={styles.aboutValue}>expo-location</Text>
            </View>
            <View style={styles.aboutRow}>
              <Text style={styles.aboutLabel}>技术栈</Text>
              <Text style={styles.aboutValue}>React Native + Expo</Text>
            </View>
            <View style={styles.aboutDivider} />
            <Text style={styles.aboutCopyright}>© 2026 pengwc.asia</Text>
            <TouchableOpacity
              style={styles.aboutCloseBtn}
              onPress={() => setAboutModalVisible(false)}
            >
              <Text style={styles.aboutCloseBtnText}>关闭</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      {/* 版本更新弹框 */}
      <Modal visible={updateModalVisible} transparent animationType="fade" onRequestClose={() => setUpdateModalVisible(false)}>
        <View style={styles.modalOverlay}>
          <View style={styles.aboutModalContent}>
            <Text style={styles.aboutTitle}>📦 发现新版本</Text>
            <Text style={styles.updateVersionText}>v{updateInfo?.version || ''}</Text>
            <View style={styles.aboutDivider} />
            {updateInfo?.changelog ? (
              <Text style={styles.updateChangelogText}>{updateInfo.changelog}</Text>
            ) : null}
            <View style={styles.aboutDivider} />
            {downloading ? (
              <View style={{ alignItems: 'center', paddingVertical: 12 }}>
                <ActivityIndicator size="small" color="#007AFF" />
                <Text style={styles.updateProgressText}>下载中...</Text>
              </View>
            ) : (
              <View style={styles.updateBtnRow}>
                <TouchableOpacity
                  style={[styles.aboutCloseBtn, { flex: 1, marginRight: 8 }]}
                  onPress={() => setUpdateModalVisible(false)}
                >
                  <Text style={styles.aboutCloseBtnText}>稍后再说</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={[styles.updateDownloadBtn, { flex: 1, marginLeft: 8 }]}
                  onPress={handleDownloadUpdate}
                >
                  <Text style={styles.updateDownloadBtnText}>立即下载</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ==================== 内部组件 ====================

function SettingRow({ icon, title, subtitle, onPress }: {
  icon: string; title: string; subtitle?: string; onPress: () => void;
}) {
  return (
    <TouchableOpacity style={styles.settingRow} onPress={onPress} activeOpacity={0.6}>
      <View style={styles.settingIcon}>
        <Text style={styles.settingIconText}>{icon}</Text>
      </View>
      <View style={styles.settingTextBlock}>
        <Text style={styles.settingTitle}>{title}</Text>
        {subtitle && <Text style={styles.settingSubtitle}>{subtitle}</Text>}
      </View>
      <Text style={styles.settingChevron}>›</Text>
    </TouchableOpacity>
  );
}

function SettingSwitchRow({ title, subtitle, value, onValueChange }: {
  title: string; subtitle?: string; value: boolean; onValueChange: (v: boolean) => void;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.settingTextBlock}>
        <Text style={styles.settingTitle}>{title}</Text>
        {subtitle && <Text style={styles.settingSubtitle}>{subtitle}</Text>}
      </View>
      <Switch
        value={value}
        onValueChange={onValueChange}
        trackColor={{ false: '#E0E0E0', true: '#007AFF' }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}

function Divider() {
  return <View style={styles.divider} />;
}

// ==================== 样式 ====================

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 32 },

  header: {
    paddingHorizontal: 20, paddingTop: 8, paddingBottom: 16,
    backgroundColor: COLORS.bg,
  },
  title: {
    fontSize: 28, fontWeight: '700',
    color: COLORS.textPrimary, letterSpacing: -0.4,
  },

  // 用户卡片
  userCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: COLORS.card, marginHorizontal: 16, marginBottom: 16,
    padding: 16, borderRadius: 10,
    shadowColor: '#000', shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05, shadowRadius: 2, elevation: 1,
  },
  avatarWrap: { marginRight: 14 },
  avatar: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: COLORS.avatarBg,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: {
    color: '#fff', fontSize: 22, fontWeight: '700',
  },
  userInfo: { flex: 1 },
  userName: {
    fontSize: 16, fontWeight: '600', color: COLORS.textPrimary, marginBottom: 4,
  },
  userEmail: { fontSize: 12, color: COLORS.textMuted },
  loginBtn: {
    backgroundColor: COLORS.accent, paddingHorizontal: 18, paddingVertical: 8,
    borderRadius: 6,
  },
  loginBtnText: { color: '#fff', fontSize: 13, fontWeight: '600' },
  logoutBtn: {
    borderWidth: 1, borderColor: COLORS.cardBorder,
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 6,
  },
  logoutBtnText: { color: COLORS.danger, fontSize: 12, fontWeight: '600' },

  // 设置项卡片
  card: {
    backgroundColor: COLORS.card, marginHorizontal: 16, marginBottom: 16,
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
    backgroundColor: COLORS.bg,
    alignItems: 'center', justifyContent: 'center',
    marginRight: 12,
  },
  settingIconText: { fontSize: 16, color: COLORS.textPrimary },
  settingTextBlock: { flex: 1 },
  settingTitle: { fontSize: 15, color: COLORS.textPrimary, fontWeight: '500' },
  settingSubtitle: { fontSize: 11, color: COLORS.textMuted, marginTop: 2 },
  settingChevron: { fontSize: 18, color: COLORS.textMuted, marginLeft: 8 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.divider, marginLeft: 56 },

  // 登录弹框
  modalOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.4)',
    justifyContent: 'center', alignItems: 'center',
  },
  loginModalContent: {
    backgroundColor: COLORS.card, borderRadius: 12, padding: 20,
    width: '85%', maxWidth: 360,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, shadowRadius: 8, elevation: 10,
  },
  loginModalTitle: {
    fontSize: 18, fontWeight: '700', color: COLORS.textPrimary,
    textAlign: 'center', marginBottom: 4,
  },
  loginModalSubtitle: {
    fontSize: 12, color: COLORS.textMuted, textAlign: 'center', marginBottom: 18,
  },
  loginInput: {
    borderWidth: 1, borderColor: COLORS.cardBorder, borderRadius: 8,
    paddingHorizontal: 12, paddingVertical: 10, fontSize: 15,
    color: COLORS.textPrimary, marginBottom: 12,
    backgroundColor: COLORS.bg,
  },
  loginModalActions: { flexDirection: 'row', gap: 10, marginTop: 8 },
  loginModalBtn: { flex: 1, paddingVertical: 11, borderRadius: 6, alignItems: 'center' },
  loginModalBtnGhost: {
    backgroundColor: COLORS.bg, borderWidth: 1, borderColor: COLORS.cardBorder,
  },
  loginModalBtnGhostText: { color: COLORS.textPrimary, fontSize: 14, fontWeight: '600' },
  loginModalBtnPrimary: { backgroundColor: COLORS.accent },
  loginModalBtnPrimaryText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  // 登录/注册弹框底部入口
  registerEntry: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    marginTop: 16,
  },
  registerEntryText: { fontSize: 13, color: COLORS.textMuted },
  registerEntryLink: { fontSize: 13, color: COLORS.accent, fontWeight: '600' },

  // 底部弹窗(sheet)
  sheetModal: {
    backgroundColor: COLORS.card, borderTopLeftRadius: 14, borderTopRightRadius: 14,
    width: '100%', position: 'absolute', bottom: 0,
    maxHeight: '90%',
  },
  sheetHeader: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.divider,
  },
  sheetTitle: { fontSize: 17, fontWeight: '600', color: COLORS.textPrimary },
  sheetClose: { color: COLORS.accent, fontSize: 15, fontWeight: '500' },
  sheetHeaderRight: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  sheetHeaderBtn: { paddingVertical: 2, paddingHorizontal: 4 },
  sheetHeaderBtnText: { color: COLORS.danger, fontSize: 14, fontWeight: '500' },
  sheetBody: { paddingBottom: 32 },
  sheetSection: {
    fontSize: 11, color: COLORS.textMuted, letterSpacing: 1,
    textTransform: 'uppercase', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 8,
    fontWeight: '600',
  },
  sheetCard: {
    backgroundColor: COLORS.bg, marginHorizontal: 16, borderRadius: 10,
    paddingHorizontal: 4,
  },

  // 空状态
  emptyContainer: {
    alignItems: 'center', paddingVertical: 60,
  },
  emptyIcon: { fontSize: 48, marginBottom: 16 },
  emptyText: { fontSize: 15, color: COLORS.textSecondary, marginBottom: 6 },
  emptyHint: { fontSize: 12, color: COLORS.textMuted },

  // 导航轨迹项
  trackItem: { flexDirection: 'row', alignItems: 'center', padding: 12 },
  trackIndex: {
    width: 32, height: 32, borderRadius: 16, backgroundColor: COLORS.avatarBg,
    alignItems: 'center', justifyContent: 'center', marginRight: 12,
  },
  trackIndexText: { color: '#fff', fontSize: 13, fontWeight: '700' },
  trackInfo: { flex: 1 },
  trackRoute: { fontSize: 14, color: COLORS.textPrimary, fontWeight: '500', marginBottom: 2 },
  trackTime: { fontSize: 11, color: COLORS.textMuted, marginBottom: 6 },
  trackStats: { flexDirection: 'row', gap: 14 },
  trackStat: { fontSize: 12, color: COLORS.textSecondary },

  // 关于弹框
  aboutModalContent: {
    backgroundColor: COLORS.card, borderRadius: 12, padding: 24,
    width: '85%', maxWidth: 360,
    shadowColor: '#000', shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2, shadowRadius: 8, elevation: 10,
  },
  aboutTitle: {
    fontSize: 20, fontWeight: '700', color: COLORS.textPrimary,
    textAlign: 'center',
  },
  aboutVersion: {
    fontSize: 12, color: COLORS.textMuted, textAlign: 'center', marginTop: 4,
  },
  aboutDivider: { height: StyleSheet.hairlineWidth, backgroundColor: COLORS.divider, marginVertical: 16 },
  aboutRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 10 },
  aboutLabel: { fontSize: 13, color: COLORS.textMuted },
  aboutValue: { fontSize: 13, color: COLORS.textPrimary, maxWidth: '60%', textAlign: 'right' },
  aboutCopyright: {
    fontSize: 11, color: COLORS.textMuted, textAlign: 'center',
  },
  aboutCloseBtn: {
    marginTop: 16, backgroundColor: COLORS.accent,
    paddingVertical: 10, borderRadius: 6, alignItems: 'center',
  },
  aboutCloseBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },

  // 更新弹框样式
  updateVersionText: {
    fontSize: 22, fontWeight: '700', color: COLORS.accent,
    textAlign: 'center', marginVertical: 8,
  },
  updateChangelogText: {
    fontSize: 13, color: COLORS.textSecondary, lineHeight: 20,
    paddingHorizontal: 8,
  },
  updateProgressText: {
    fontSize: 13, color: COLORS.textMuted, marginTop: 8,
  },
  updateBtnRow: {
    flexDirection: 'row', alignItems: 'center',
  },
  updateDownloadBtn: {
    backgroundColor: COLORS.success, paddingVertical: 10,
    borderRadius: 6, alignItems: 'center',
  },
  updateDownloadBtnText: {
    color: '#fff', fontSize: 14, fontWeight: '600',
  },
});
