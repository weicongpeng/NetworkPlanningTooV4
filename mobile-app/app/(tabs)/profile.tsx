import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, Image, ScrollView, TouchableOpacity, Alert, Appearance } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useNavigation } from '@react-navigation/native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { apiService } from '../../src/services/api';
import { cacheService } from '../../src/services/cacheService';
import { login as authLogin, register as authRegister, logout as authLogout, fetchMe, getStoredUser, setStoredUser, AuthUser } from '../../src/services/auth';
import { useMapStore } from '../../src/store/mapStore';
import { useImStore } from '../../src/store/imStore';
import ProfileModals, { type ProfileModalModel } from '../../src/components/Profile/ProfileModals';
import {
  LIGHT_COLORS, DARK_COLORS, SettingRow, Divider, FootprintIcon,
} from '../../src/components/Profile/ProfileUi';
import { styles } from '../../src/components/Profile/profileStyles';
import { useAppUpdate } from '../../src/components/Profile/useAppUpdate';
import ProfileEditor, { type ProfilePatch } from '../../src/components/Profile/ProfileEditor';

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
  const favoriteCount = useMapStore((s) => s.favorites.length);
  const clearNavTracksGlobal = useMapStore((s) => s.clearNavTracks);
  const navigation = useNavigation<any>();
  // 动态配色
  const COLORS = darkMode ? DARK_COLORS : LIGHT_COLORS;

  // 心跳已移到 App 根组件常驻，避免 Tab 懒加载时漏跑

  // 登录态以 mapStore 为单一真源：401 失效清理会立即同步到本页
  const isLoggedIn = useMapStore((s) => s.isLoggedIn);
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

  const sessionExpired = useImStore((s) => s.sessionExpired);
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
  const [editorVisible, setEditorVisible] = useState(false);

  // 会话失效后进入「我的」自动弹登录框，少一次手动点击
  useEffect(() => {
    if (sessionExpired) setLoginModalVisible(true);
  }, [sessionExpired]);

  const update = useAppUpdate();

  const applyProfilePatch = useCallback((patch: ProfilePatch) => {
    const next: AuthUser = { ...(userInfo || {}), ...patch } as AuthUser;
    setUserInfo(next);
    setLoggedInGlobal(next);
    void setStoredUser(next);
    void AsyncStorage.setItem(STORAGE_KEYS.userInfo, JSON.stringify(next));
  }, [userInfo, setLoggedInGlobal]);

  const avatarSource = userInfo?.avatar
    && (userInfo.avatar.startsWith('data:') || userInfo.avatar.startsWith('http'))
    ? { uri: userInfo.avatar }
    : null;

  // 加载本地数据
  useEffect(() => {
    (async () => {
      try {
        // 优先从 auth 服务存储读取（包含 token 关联的最新用户信息）
        const stored = await getStoredUser();
        if (stored) {
          console.log('[Profile] stored user:', JSON.stringify(stored));
          setUserInfo(stored);
          setLoggedInGlobal(stored);
        } else {
          // 回退到旧版存储，避免老用户掉登录
          const u = await AsyncStorage.getItem(STORAGE_KEYS.userInfo);
          if (u) {
            const parsed = JSON.parse(u);
            setUserInfo(parsed);
            setLoggedInGlobal(parsed);
          }
        }
        // appSettings / navTracks / darkMode 由 mapStore persist 自动恢复
        // 若有 token，尝试拉取一次最新用户信息（静默失败不打扰用户）
        try {
          const me = await fetchMe();
          if (me) {
            setUserInfo(me);
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
      setLoggedInGlobal(result.user);  // 同步到全局 store，其他 Tab 解锁
      void useImStore.getState().bootstrap();
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
      setLoggedInGlobal(result.user);  // 同步到全局 store
      void useImStore.getState().bootstrap();
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
          setUserInfo(null);
          clearLoggedInGlobal();  // 同步全局，其他 Tab 立即进入预览态
          useImStore.getState().resetForUserSwitch();
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

  const modalModel: ProfileModalModel = {
    loginVisible: loginModalVisible, setLoginVisible: setLoginModalVisible,
    loginUsername, setLoginUsername, loginPassword, setLoginPassword,
    loginLoading, handleLogin, openRegister,
    registerVisible: registerModalVisible, closeRegister,
    regUsername, setRegUsername, regPassword, setRegPassword,
    regPasswordConfirm, setRegPasswordConfirm, regCity, setRegCity,
    regOperator, regLoading, handleRegister,
    operatorVisible: operatorPickerVisible, setOperatorVisible: setOperatorPickerVisible,
    selectOperator: (op: string) => selectOperator(op as Operator), operators: OPERATORS,
    settingsVisible: appSettingsModalVisible, setSettingsVisible: setAppSettingsModalVisible,
    darkMode, appSettings, handleToggleDarkMode, handleToggleAutoSync, handleToggleTts,
    cacheSize, clearingCache, refreshCacheSize, handleClearCache, isAdmin: !!isAdmin,
    tracksVisible: tracksModalVisible, setTracksVisible: setTracksModalVisible,
    navTracks, handleClearTracks,
    aboutVisible: aboutModalVisible, setAboutVisible: setAboutModalVisible,
    currentApiUrl,
    checkingUpdate: update.checkingUpdate,
    handleCheckUpdate: update.handleCheckUpdate,
    downloadVisible: update.downloadModalVisible,
    setDownloadVisible: update.setDownloadModalVisible,
    downloadPhase: update.downloadPhase,
    downloadPercent: update.downloadPercent,
    downloadedBytes: update.downloadedBytes,
    totalBytes: update.totalBytes,
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
          <TouchableOpacity
            style={styles.avatarWrap}
            onPress={() => { if (isLoggedIn) setEditorVisible(true); }}
            activeOpacity={0.7}
          >
            {avatarSource ? (
              <Image source={avatarSource} style={[styles.avatar, { backgroundColor: COLORS.avatarBg }]} />
            ) : (
              <View style={[styles.avatar, { backgroundColor: COLORS.avatarBg }]}>
                <Text style={styles.avatarText}>
                  {isLoggedIn
                    ? (userInfo?.username?.substring(0, 1)?.toUpperCase() || 'U')
                    : '访'}
                </Text>
              </View>
            )}
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.userInfo}
            onPress={() => { if (isLoggedIn) setEditorVisible(true); }}
            activeOpacity={0.7}
          >
            {isLoggedIn ? (
              <>
                <Text style={[styles.userName, { color: COLORS.textPrimary }]}>
                  {userInfo?.nickname || userInfo?.username}
                </Text>
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
          </TouchableOpacity>
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

        {/* 数据：原「数据」「收藏」两个 Tab 迁到这里 */}
        <Text style={[styles.sheetSection, { color: COLORS.textMuted, textTransform: 'none' }]}>数据</Text>
        <View style={[styles.card, { backgroundColor: COLORS.card }]}>
          <SettingRow
            icon="▤" title="数据管理" subtitle="工参导入、后端加载与缓存"
            onPress={() => navigation.navigate('DataCenter')}
            colors={COLORS}
          />
          <Divider colors={COLORS} />
          <SettingRow
            icon="★" title="我的收藏" subtitle={favoriteCount > 0 ? `${favoriteCount} 个收藏点` : '暂无收藏点'}
            onPress={() => navigation.navigate('Favorites')}
            colors={COLORS}
          />
        </View>

        {/* 个性设置 */}
        <Text style={[styles.sheetSection, { color: COLORS.textMuted, textTransform: 'none' }]}>个性设置</Text>
        <View style={[styles.card, { backgroundColor: COLORS.card }]}>
          <SettingRow
            icon="◐" title="设置" subtitle={`深色 ${darkMode ? '开' : '关'} · 同步 ${appSettings.autoSync ? '开' : '关'} · 语音 ${appSettings.ttsEnabled ? '开' : '关'}`}
            onPress={() => setAppSettingsModalVisible(true)}
            colors={COLORS}
          />
          <Divider colors={COLORS} />
          <SettingRow
            icon={<FootprintIcon color={COLORS.textPrimary} size={18} />}
            title="我的足迹" subtitle={navTracks.length > 0 ? `${navTracks.length} 条轨迹` : '暂无足迹'}
            onPress={() => setTracksModalVisible(true)}
            colors={COLORS}
          />
        </View>

        {/* 关于 */}
        <Text style={[styles.sheetSection, { color: COLORS.textMuted, textTransform: 'none' }]}>关于</Text>
        <View style={[styles.card, { backgroundColor: COLORS.card }]}>
          <SettingRow
            icon="ⓘ" title="关于" subtitle="版本与服务信息"
            onPress={() => setAboutModalVisible(true)}
            colors={COLORS}
          />
        </View>

        <View style={{ height: 24 }} />
      </ScrollView>

      <ProfileModals model={modalModel} colors={COLORS} styles={styles} />
      <ProfileEditor
        visible={editorVisible}
        colors={COLORS}
        styles={styles}
        user={userInfo}
        onClose={() => setEditorVisible(false)}
        onSaved={applyProfilePatch}
      />
    </View>
  );
}
