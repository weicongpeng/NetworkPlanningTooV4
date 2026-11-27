/** 根栈 + 底部 Tab 混合导航下的统一跳转，避免二级页 navigate('map') 找不到路由。 */
export function navigateToTab(navigation: any, tab: 'map' | 'communication' | 'profile'): void {
  // 二级页位于根栈内：当前 navigator 就持有 Tabs 路由
  const ownNames: string[] = navigation?.getState?.()?.routeNames || [];
  if (ownNames.includes('Tabs')) {
    navigation.navigate('Tabs', { screen: tab });
    return;
  }
  // Tab 页位于 Tabs navigator 内：父级根栈持有 Tabs 路由
  const parent = navigation?.getParent?.();
  const parentNames: string[] = parent?.getState?.()?.routeNames || [];
  if (parentNames.includes('Tabs')) {
    parent.navigate('Tabs', { screen: tab });
    return;
  }
  navigation?.navigate?.(tab);
}
