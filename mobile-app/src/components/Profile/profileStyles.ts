import { StyleSheet } from 'react-native';

// ==================== 样式 ====================

export const styles = StyleSheet.create({
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
