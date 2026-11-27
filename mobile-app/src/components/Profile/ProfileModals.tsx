/** 「我的」页弹层集合：登录/注册、设置、足迹、关于与下载进度。 */
import React from 'react';
import {
  View, Text, TextInput, Modal, ActivityIndicator, TouchableOpacity,
  ScrollView, Clipboard, Share, ToastAndroid, TouchableWithoutFeedback,
} from 'react-native';
import Constants from 'expo-constants';

import BackendSettings from './BackendSettings';
import AccountModals from './AccountModals';
import {
  Divider, SettingSwitchRow, formatBytes, formatDistance, formatDuration,
  type AppColors,
} from './ProfileUi';
import type { NavTrackItem } from '../../store/mapStore';

export interface ProfileModalModel {
  loginVisible: boolean
  setLoginVisible: (v: boolean) => void
  loginUsername: string
  setLoginUsername: (v: string) => void
  loginPassword: string
  setLoginPassword: (v: string) => void
  loginLoading: boolean
  handleLogin: () => void
  openRegister: () => void

  registerVisible: boolean
  closeRegister: () => void
  regUsername: string
  setRegUsername: (v: string) => void
  regPassword: string
  setRegPassword: (v: string) => void
  regPasswordConfirm: string
  setRegPasswordConfirm: (v: string) => void
  regCity: string
  setRegCity: (v: string) => void
  regOperator: string
  regLoading: boolean
  handleRegister: () => void
  operatorVisible: boolean
  setOperatorVisible: (v: boolean) => void
  selectOperator: (op: string) => void
  operators: readonly string[]

  settingsVisible: boolean
  setSettingsVisible: (v: boolean) => void
  darkMode: boolean
  appSettings: { autoSync: boolean; ttsEnabled: boolean }
  handleToggleDarkMode: (v: boolean) => void
  handleToggleAutoSync: (v: boolean) => void
  handleToggleTts: (v: boolean) => void
  cacheSize: number
  clearingCache: boolean
  refreshCacheSize: () => void
  handleClearCache: () => void
  isAdmin: boolean

  tracksVisible: boolean
  setTracksVisible: (v: boolean) => void
  navTracks: NavTrackItem[]
  handleClearTracks: () => void

  aboutVisible: boolean
  setAboutVisible: (v: boolean) => void
  currentApiUrl: string
  checkingUpdate: boolean
  handleCheckUpdate: () => void

  downloadVisible: boolean
  setDownloadVisible: (v: boolean) => void
  downloadPhase: 'idle' | 'downloading' | 'installing' | 'done' | 'error'
  downloadPercent: number
  downloadedBytes: number
  totalBytes: number
}

interface Props {
  model: ProfileModalModel
  colors: AppColors
  styles: any
}

export default function ProfileModals({ model, colors, styles }: Props) {
  const {
    loginVisible, setLoginVisible, loginUsername, setLoginUsername,
    loginPassword, setLoginPassword, loginLoading, handleLogin, openRegister,
    registerVisible, closeRegister, regUsername, setRegUsername,
    regPassword, setRegPassword, regPasswordConfirm, setRegPasswordConfirm,
    regCity, setRegCity, regOperator, regLoading, handleRegister,
    operatorVisible, setOperatorVisible, selectOperator, operators,
    settingsVisible, setSettingsVisible, darkMode, appSettings,
    handleToggleDarkMode, handleToggleAutoSync, handleToggleTts,
    cacheSize, clearingCache, refreshCacheSize, handleClearCache, isAdmin,
    tracksVisible, setTracksVisible, navTracks, handleClearTracks,
    aboutVisible, setAboutVisible, currentApiUrl, checkingUpdate, handleCheckUpdate,
    downloadVisible, setDownloadVisible, downloadPhase, downloadPercent,
    downloadedBytes, totalBytes,
  } = model;

  return (
    <>
      <AccountModals model={model} colors={colors} styles={styles} />
      {/* 设置 */}
      <Modal visible={settingsVisible} transparent animationType="slide" onRequestClose={() => setSettingsVisible(false)} onShow={refreshCacheSize}>
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.sheetModal, { maxHeight: '80%', backgroundColor: colors.card }]}>
            <View style={[styles.sheetHeader, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>设置</Text>
              <TouchableOpacity onPress={() => setSettingsVisible(false)}>
                <Text style={[styles.sheetClose, { color: colors.accent }]}>完成</Text>
              </TouchableOpacity>
            </View>
            <ScrollView style={styles.sheetBody}>
              <Text style={[styles.sheetSection, { color: colors.textMuted }]}>设置</Text>
              <View style={[styles.sheetCard, { backgroundColor: colors.card }]}>
                <SettingSwitchRow title="深色模式" subtitle="切换应用深色主题" value={darkMode}
                  onValueChange={handleToggleDarkMode} trackFalseColor={colors.switchTrackFalse} colors={colors} />
                <Divider colors={colors} />
                <SettingSwitchRow title="自动同步" subtitle="启动时自动同步最新工参" value={appSettings.autoSync}
                  onValueChange={handleToggleAutoSync} trackFalseColor={colors.switchTrackFalse} colors={colors} />
                <Divider colors={colors} />
                <SettingSwitchRow title="语音播报" subtitle="导航过程中播报转向" value={appSettings.ttsEnabled}
                  onValueChange={handleToggleTts} trackFalseColor={colors.switchTrackFalse} colors={colors} />
              </View>

              <Text style={[styles.sheetSection, { color: colors.textMuted }]}>存储</Text>
              <View style={[styles.sheetCard, { backgroundColor: colors.card }]}>
                <TouchableOpacity style={styles.settingRow} onPress={handleClearCache} disabled={clearingCache} activeOpacity={0.6}>
                  <View style={styles.settingTextBlock}>
                    <Text style={[styles.settingTitle, { color: colors.danger }]}>清除缓存</Text>
                    <Text style={[styles.settingSubtitle, { color: colors.textMuted }]}>
                      {cacheSize > 0 ? `当前缓存 ${(cacheSize / 1024 / 1024).toFixed(1)} MB` : '暂无缓存数据'}
                    </Text>
                  </View>
                  {clearingCache
                    ? <ActivityIndicator size="small" color={colors.danger} />
                    : <Text style={[styles.settingChevron, { color: colors.textMuted }]}>›</Text>}
                </TouchableOpacity>
              </View>

              {isAdmin && (
                <>
                  <Text style={[styles.sheetSection, { color: colors.textMuted }]}>后端设置</Text>
                  <View style={[styles.sheetCard, { backgroundColor: colors.card }]}>
                    <BackendSettings colors={colors} />
                  </View>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 我的足迹 */}
      <Modal visible={tracksVisible} transparent animationType="slide" onRequestClose={() => setTracksVisible(false)}>
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.sheetModal, { maxHeight: '85%', backgroundColor: colors.card }]}>
            <View style={[styles.sheetHeader, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.sheetTitle, { color: colors.textPrimary }]}>我的足迹</Text>
              <View style={styles.sheetHeaderRight}>
                {navTracks.length > 0 && (
                  <TouchableOpacity onPress={handleClearTracks} style={styles.sheetHeaderBtn}>
                    <Text style={[styles.sheetHeaderBtnText, { color: colors.danger }]}>清空</Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity onPress={() => setTracksVisible(false)}>
                  <Text style={[styles.sheetClose, { color: colors.accent }]}>完成</Text>
                </TouchableOpacity>
              </View>
            </View>
            <ScrollView style={styles.sheetBody}>
              {navTracks.length === 0 ? (
                <View style={styles.emptyContainer}>
                  <Text style={styles.emptyIcon}>👣</Text>
                  <Text style={[styles.emptyText, { color: colors.textSecondary }]}>暂无足迹记录</Text>
                  <Text style={[styles.emptyHint, { color: colors.textMuted }]}>使用导航后会自动保存轨迹</Text>
                </View>
              ) : (
                <>
                  <View style={[styles.sheetCard, { backgroundColor: colors.inputBg }]}>
                    <View style={styles.footprintSummary}>
                      <View style={styles.footprintSummaryItem}>
                        <Text style={[styles.footprintSummaryValue, { color: colors.accent }]}>{navTracks.length}</Text>
                        <Text style={[styles.footprintSummaryLabel, { color: colors.textMuted }]}>轨迹数</Text>
                      </View>
                      <View style={[styles.footprintSummaryDivider, { backgroundColor: colors.divider }]} />
                      <View style={styles.footprintSummaryItem}>
                        <Text style={[styles.footprintSummaryValue, { color: colors.accent }]}>
                          {formatDistance(navTracks.reduce((sum, t) => sum + (t.distance || 0), 0))}
                        </Text>
                        <Text style={[styles.footprintSummaryLabel, { color: colors.textMuted }]}>总里程</Text>
                      </View>
                      <View style={[styles.footprintSummaryDivider, { backgroundColor: colors.divider }]} />
                      <View style={styles.footprintSummaryItem}>
                        <Text style={[styles.footprintSummaryValue, { color: colors.accent }]}>
                          {formatDuration(navTracks.reduce((sum, t) => sum + (t.duration || 0), 0))}
                        </Text>
                        <Text style={[styles.footprintSummaryLabel, { color: colors.textMuted }]}>总时长</Text>
                      </View>
                    </View>
                  </View>
                  <View style={[styles.sheetCard, { backgroundColor: colors.inputBg }]}>
                    {navTracks.map((track, index) => (
                      <View key={track.id}>
                        <View style={styles.trackItem}>
                          <View style={[styles.trackIndex, { backgroundColor: colors.avatarBg }]}>
                            <Text style={styles.trackIndexText}>{index + 1}</Text>
                          </View>
                          <View style={styles.trackInfo}>
                            <Text style={[styles.trackRoute, { color: colors.textPrimary }]}>
                              {track.startName || '起点'} → {track.endName || '终点'}
                            </Text>
                            <Text style={[styles.trackTime, { color: colors.textMuted }]}>
                              {new Date(track.startTime).toLocaleString()}
                            </Text>
                            <View style={styles.trackStats}>
                              <Text style={[styles.trackStat, { color: colors.textSecondary }]}>📍 {formatDistance(track.distance)}</Text>
                              <Text style={[styles.trackStat, { color: colors.textSecondary }]}>⏱ {formatDuration(track.duration)}</Text>
                            </View>
                          </View>
                        </View>
                        {index < navTracks.length - 1 && <Divider colors={colors} />}
                      </View>
                    ))}
                  </View>
                </>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      {/* 关于 */}
      <Modal visible={aboutVisible} transparent animationType="fade" onRequestClose={() => setAboutVisible(false)}>
        <TouchableWithoutFeedback onPress={() => setAboutVisible(false)}>
          <View style={[styles.modalOverlay, { backgroundColor: colors.overlayBg }]}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={[styles.aboutModalContent, { backgroundColor: colors.card }]}>
                <Text style={[styles.aboutTitle, { color: colors.textPrimary }]}>网优伴侣</Text>
                <Text style={[styles.aboutVersion, { color: colors.textMuted }]}>V{Constants.expoConfig?.version || '2.0.0'}</Text>
                <View style={[styles.aboutDivider, { backgroundColor: colors.divider }]} />
                <View style={styles.aboutRow}>
                  <Text style={[styles.aboutLabel, { color: colors.textMuted }]}>PC端地址</Text>
                  <TouchableOpacity
                    onPress={() => {
                      if (currentApiUrl) {
                        Clipboard.setString(currentApiUrl);
                        ToastAndroid?.show('已复制到剪贴板', ToastAndroid?.SHORT);
                      }
                    }}
                    activeOpacity={0.6}
                  >
                    <Text style={[styles.aboutValue, { color: colors.accent, textDecorationLine: 'underline' }]} numberOfLines={1} ellipsizeMode="tail">
                      {currentApiUrl || '—'}
                    </Text>
                  </TouchableOpacity>
                </View>
                <View style={styles.aboutRow}>
                  <Text style={[styles.aboutLabel, { color: colors.textMuted }]}>管理员微信</Text>
                  <TouchableOpacity
                    onPress={() => {
                      Clipboard.setString('pengwc2010');
                      ToastAndroid?.show('微信号已复制', ToastAndroid?.SHORT);
                    }}
                    activeOpacity={0.6}
                  >
                    <Text style={[styles.aboutValue, { color: colors.accent, textDecorationLine: 'underline' }]}>pengwc2010</Text>
                  </TouchableOpacity>
                </View>
                <View style={[styles.aboutDivider, { backgroundColor: colors.divider }]} />
                <TouchableOpacity
                  style={[styles.aboutShareBtn, { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }]}
                  onPress={handleCheckUpdate}
                  disabled={checkingUpdate}
                  activeOpacity={0.7}
                >
                  {checkingUpdate ? (
                    <>
                      <ActivityIndicator size="small" color={colors.accent} style={{ marginRight: 8 }} />
                      <Text style={[styles.aboutShareBtnText, { color: colors.accent }]}>检查中...</Text>
                    </>
                  ) : (
                    <Text style={[styles.aboutShareBtnText, { color: colors.accent }]}>检查更新</Text>
                  )}
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.aboutShareBtn}
                  onPress={() => {
                    void Share.share({
                      title: '网优伴侣',
                      message: '网优伴侣 - 网络优化工程师的移动助手\n下载链接：',
                    });
                  }}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.aboutShareBtnText, { color: colors.accent }]}>分享给好友</Text>
                </TouchableOpacity>
                <Text style={[styles.aboutCopyright, { color: colors.textMuted }]}>© 2026 pengwc.asia</Text>
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>

      {/* 下载进度 */}
      <Modal visible={downloadVisible} transparent animationType="fade" onRequestClose={() => {
        if (downloadPhase === 'downloading' || downloadPhase === 'installing') return;
        setDownloadVisible(false);
      }}>
        <TouchableWithoutFeedback onPress={() => {
          if (downloadPhase !== 'downloading' && downloadPhase !== 'installing') setDownloadVisible(false);
        }}>
          <View style={[styles.modalOverlay, { backgroundColor: colors.overlayBg }]}>
            <TouchableWithoutFeedback onPress={() => {}}>
              <View style={[styles.aboutModalContent, { backgroundColor: colors.card, padding: 24 }]}>
                {downloadPhase === 'downloading' && (
                  <>
                    <Text style={[styles.aboutTitle, { color: colors.textPrimary, fontSize: 18, marginBottom: 8 }]}>正在下载更新</Text>
                    <Text style={[styles.aboutVersion, { color: colors.textMuted, marginBottom: 20 }]}>
                      {downloadPercent > 0 ? `${downloadPercent.toFixed(1)}%` : '准备中...'}
                    </Text>
                    <View style={[styles.progressBarBg, { backgroundColor: colors.inputBg }]}>
                      <View style={{ width: `${Math.min(100, downloadPercent)}%`, height: '100%', backgroundColor: colors.accent, borderRadius: 4 }} />
                    </View>
                    <Text style={[styles.aboutVersion, { color: colors.textMuted, fontSize: 12, marginTop: 12 }]}>
                      {formatBytes(downloadedBytes)} / {totalBytes > 0 ? formatBytes(totalBytes) : '?'}
                    </Text>
                    <Text style={[styles.aboutVersion, { color: colors.textMuted, fontSize: 12, marginTop: 8 }]}>
                      优先走 Tailscale 直连，绕过 CF Tunnel 限速
                    </Text>
                  </>
                )}
                {downloadPhase === 'installing' && (
                  <>
                    <Text style={[styles.aboutTitle, { color: colors.textPrimary, fontSize: 18, marginBottom: 16 }]}>下载完成</Text>
                    <ActivityIndicator size="large" color={colors.accent} style={{ marginBottom: 16 }} />
                    <Text style={[styles.aboutVersion, { color: colors.textMuted }]}>正在调起安装器...</Text>
                  </>
                )}
                {downloadPhase === 'done' && (
                  <>
                    <Text style={[styles.aboutTitle, { color: colors.textPrimary, fontSize: 18, marginBottom: 16 }]}>下载完成</Text>
                    <Text style={[styles.aboutVersion, { color: colors.success }]}>✓ 请在系统安装器中完成安装</Text>
                    <TouchableOpacity style={[styles.aboutShareBtn, { marginTop: 16 }]} onPress={() => setDownloadVisible(false)} activeOpacity={0.7}>
                      <Text style={[styles.aboutShareBtnText, { color: colors.accent }]}>关闭</Text>
                    </TouchableOpacity>
                  </>
                )}
                {downloadPhase === 'error' && (
                  <>
                    <Text style={[styles.aboutTitle, { color: colors.textPrimary, fontSize: 18, marginBottom: 16 }]}>下载失败</Text>
                    <Text style={[styles.aboutVersion, { color: colors.danger }]}>请尝试使用浏览器下载</Text>
                    <TouchableOpacity style={[styles.aboutShareBtn, { marginTop: 16 }]} onPress={() => setDownloadVisible(false)} activeOpacity={0.7}>
                      <Text style={[styles.aboutShareBtnText, { color: colors.accent }]}>关闭</Text>
                    </TouchableOpacity>
                  </>
                )}
              </View>
            </TouchableWithoutFeedback>
          </View>
        </TouchableWithoutFeedback>
      </Modal>
    </>
  );
}
