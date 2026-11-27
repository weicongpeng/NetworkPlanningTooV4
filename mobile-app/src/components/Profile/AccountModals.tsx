import React from 'react';
import { View, Text, TextInput, Modal, TouchableOpacity, ActivityIndicator } from 'react-native';

import type { ProfileModalModel } from './ProfileModals';
import type { AppColors } from './ProfileUi';

export default function AccountModals({ model, colors, styles }: {
  model: ProfileModalModel; colors: AppColors; styles: any;
}) {
  const {
    loginVisible, setLoginVisible, loginUsername, setLoginUsername,
    loginPassword, setLoginPassword, loginLoading, handleLogin, openRegister,
    registerVisible, closeRegister, regUsername, setRegUsername,
    regPassword, setRegPassword, regPasswordConfirm, setRegPasswordConfirm,
    regCity, setRegCity, regOperator, regLoading, handleRegister,
    operatorVisible, setOperatorVisible, selectOperator, operators,
  } = model;
  return (
    <>
      {/* 登录弹框 */}
      <Modal visible={loginVisible} transparent animationType="fade" onRequestClose={() => setLoginVisible(false)}>
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.loginModalContent, { backgroundColor: colors.card }]}>
            <Text style={[styles.loginModalTitle, { color: colors.textPrimary }]}>登录账号</Text>
            <Text style={[styles.loginModalSubtitle, { color: colors.textMuted }]}>登录后将同步您的数据到云端</Text>
            <TextInput
              style={[styles.loginInput, { borderColor: colors.cardBorder, color: colors.textPrimary, backgroundColor: colors.inputBg }]}
              value={loginUsername}
              onChangeText={setLoginUsername}
              placeholder="用户名"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <TextInput
              style={[styles.loginInput, { borderColor: colors.cardBorder, color: colors.textPrimary, backgroundColor: colors.inputBg }]}
              value={loginPassword}
              onChangeText={setLoginPassword}
              placeholder="密码"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
            />
            <View style={styles.loginModalActions}>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnGhost, { backgroundColor: colors.inputBg, borderColor: colors.cardBorder }]}
                onPress={() => { setLoginVisible(false); setLoginUsername(''); setLoginPassword(''); }}
                disabled={loginLoading}
              >
                <Text style={[styles.loginModalBtnGhostText, { color: colors.textPrimary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnPrimary, { backgroundColor: colors.accent }]}
                onPress={handleLogin}
                disabled={loginLoading}
              >
                {loginLoading
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.loginModalBtnPrimaryText}>登录</Text>}
              </TouchableOpacity>
            </View>
            <View style={styles.registerEntry}>
              <Text style={[styles.registerEntryText, { color: colors.textMuted }]}>还没有账号？</Text>
              <TouchableOpacity onPress={openRegister} disabled={loginLoading} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={[styles.registerEntryLink, { color: colors.accent }]}>立即注册</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 注册弹框 */}
      <Modal visible={registerVisible} transparent animationType="fade" onRequestClose={closeRegister}>
        <View style={[styles.modalOverlay, { backgroundColor: colors.overlayBg }]}>
          <View style={[styles.loginModalContent, { backgroundColor: colors.card }]}>
            <Text style={[styles.loginModalTitle, { color: colors.textPrimary }]}>注册账号</Text>
            <Text style={[styles.loginModalSubtitle, { color: colors.textMuted }]}>注册后即可同步数据到云端</Text>
            <TextInput
              style={[styles.loginInput, { borderColor: colors.cardBorder, color: colors.textPrimary, backgroundColor: colors.inputBg }]}
              value={regUsername}
              onChangeText={setRegUsername}
              placeholder="用户名（至少 3 个字符）"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
            />
            <TextInput
              style={[styles.loginInput, { borderColor: colors.cardBorder, color: colors.textPrimary, backgroundColor: colors.inputBg }]}
              value={regPassword}
              onChangeText={setRegPassword}
              placeholder="密码（至少 6 个字符）"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
            />
            <TextInput
              style={[styles.loginInput, { borderColor: colors.cardBorder, color: colors.textPrimary, backgroundColor: colors.inputBg }]}
              value={regPasswordConfirm}
              onChangeText={setRegPasswordConfirm}
              placeholder="确认密码"
              placeholderTextColor={colors.textMuted}
              secureTextEntry
            />
            <TextInput
              style={[styles.loginInput, { borderColor: colors.cardBorder, color: colors.textPrimary, backgroundColor: colors.inputBg }]}
              value={regCity}
              onChangeText={setRegCity}
              placeholder="请输入地市名称"
              placeholderTextColor={colors.textMuted}
              autoCapitalize="none"
              autoCorrect={false}
            />
            <TouchableOpacity
              style={[styles.loginInput, { borderColor: colors.cardBorder, backgroundColor: colors.inputBg }]}
              onPress={() => setOperatorVisible(true)}
              activeOpacity={0.6}
              disabled={regLoading}
            >
              <Text style={regOperator ? [styles.loginInputValue, { color: colors.textPrimary }] : [styles.loginInputPlaceholder, { color: colors.textMuted }]}>
                {regOperator || '请选择运营商'}
              </Text>
              <Text style={[styles.loginInputChevron, { color: colors.textMuted }]}>▾</Text>
            </TouchableOpacity>
            <View style={styles.loginModalActions}>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnGhost, { backgroundColor: colors.inputBg, borderColor: colors.cardBorder }]}
                onPress={closeRegister}
                disabled={regLoading}
              >
                <Text style={[styles.loginModalBtnGhostText, { color: colors.textPrimary }]}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.loginModalBtn, styles.loginModalBtnPrimary, { backgroundColor: colors.accent }]}
                onPress={handleRegister}
                disabled={regLoading}
              >
                {regLoading
                  ? <ActivityIndicator color="#fff" size="small" />
                  : <Text style={styles.loginModalBtnPrimaryText}>注册</Text>}
              </TouchableOpacity>
            </View>
            <View style={styles.registerEntry}>
              <Text style={[styles.registerEntryText, { color: colors.textMuted }]}>已有账号？</Text>
              <TouchableOpacity onPress={() => { closeRegister(); setLoginVisible(true); }} disabled={regLoading} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                <Text style={[styles.registerEntryLink, { color: colors.accent }]}>返回登录</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* 运营商选择器 */}
      <Modal visible={operatorVisible} transparent animationType="fade" onRequestClose={() => setOperatorVisible(false)}>
        <TouchableOpacity
          style={[styles.modalOverlay, { backgroundColor: colors.overlayBg }]}
          activeOpacity={1}
          onPress={() => setOperatorVisible(false)}
        >
          <View style={[styles.operatorSheet, { backgroundColor: colors.card }]}>
            <View style={[styles.operatorSheetHeader, { borderBottomColor: colors.divider }]}>
              <Text style={[styles.operatorSheetTitle, { color: colors.textPrimary }]}>请选择运营商</Text>
              <TouchableOpacity onPress={() => setOperatorVisible(false)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={[styles.operatorSheetClose, { color: colors.textMuted }]}>×</Text>
              </TouchableOpacity>
            </View>
            {operators.map((op) => (
              <TouchableOpacity
                key={op}
                style={[styles.operatorItem, { borderBottomColor: colors.divider }]}
                onPress={() => selectOperator(op)}
                activeOpacity={0.6}
              >
                <Text style={[styles.operatorItemText, { color: colors.textPrimary }]}>{op}</Text>
                {regOperator === op && <Text style={[styles.operatorItemCheck, { color: colors.accent }]}>✓</Text>}
              </TouchableOpacity>
            ))}
          </View>
        </TouchableOpacity>
      </Modal>

    </>
  );
}
