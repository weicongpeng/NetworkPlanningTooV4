"""
测试地图图层加载功能，捕获控制台日志
"""
from playwright.sync_api import sync_playwright
import time

def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context()
        page = context.new_page()

        # 收集控制台日志
        console_messages = []
        def handle_console(msg):
            console_messages.append({
                'type': msg.type,
                'text': msg.text
            })
            print(f"[Console {msg.type}] {msg.text}")

        page.on('console', handle_console)

        # 导航到应用
        print("正在导航到应用...")
        page.goto('http://localhost:5173')
        page.wait_for_load_state('networkidle')
        print("页面加载完成")

        # 截图看看当前状态
        page.screenshot(path='D:/mycode/NetworkPlanningTooV3/tmp/1_initial.png')
        print("已截图: 1_initial.png")

        # 等待一下让应用完全初始化
        time.sleep(2)

        # 尝试点击"地图工具"菜单项
        print("\n尝试点击地图工具菜单...")
        try:
            # 尝试多种选择器
            menu_selectors = [
                'text=地图工具',
                '[role="menuitem"]:has-text("地图工具")',
                'a:has-text("地图工具")',
            ]
            clicked = False
            for selector in menu_selectors:
                try:
                    if page.locator(selector).count() > 0:
                        print(f"找到菜单项: {selector}")
                        page.locator(selector).first.click()
                        clicked = True
                        break
                except Exception as e:
                    pass

            if not clicked:
                print("未找到地图工具菜单，尝试直接访问...")
                page.goto('http://localhost:5173/map')
        except Exception as e:
            print(f"点击菜单失败: {e}")
            # 尝试直接导航到地图页面
            page.goto('http://localhost:5173/map')

        page.wait_for_load_state('networkidle')
        time.sleep(2)
        page.screenshot(path='D:/mycode/NetworkPlanningTooV3/tmp/2_map_page.png')
        print("已截图: 2_map_page.png")

        # 查找图层控制面板
        print("\n查找图层控制...")
        layer_control_selectors = [
            'text=图层控制',
            '[class*="layer"][class*="control"]',
        ]

        # 截图整个页面以便检查
        page.screenshot(path='D:/mycode/NetworkPlanningTooV3/tmp/3_full_page.png', full_page=True)
        print("已截图: 3_full_page.png")

        # 打印页面内容以便调试
        html_content = page.content()
        with open('D:/mycode/NetworkPlanningTooV3/tmp/page_content.html', 'w', encoding='utf-8') as f:
            f.write(html_content)
        print("已保存页面HTML")

        # 查找复选框
        print("\n查找复选框...")
        checkboxes = page.locator('input[type="checkbox"]').all()
        print(f"找到 {len(checkboxes)} 个复选框")

        for i, checkbox in enumerate(checkboxes):
            try:
                # 获取复选框的父元素来查看标签
                parent = checkbox.evaluate("el => el.parentElement.textContent")
                print(f"复选框 {i}: {parent[:50]}...")
                is_checked = checkbox.is_checked()
                print(f"  当前状态: {'已勾选' if is_checked else '未勾选'}")
            except:
                pass

        # 尝试勾选第一个未勾选的图层
        print("\n尝试勾选图层...")
        try:
            # 查找"地理化数据"相关的复选框
            geo_checkboxes = page.locator('input[type="checkbox"]').all()
            for checkbox in geo_checkboxes:
                if not checkbox.is_checked():
                    # 获取标签文本
                    label_text = checkbox.evaluate("el => el.parentElement.textContent")
                    if '地理化' in label_text or '图层' in label_text:
                        print(f"勾选复选框: {label_text[:50]}...")
                        checkbox.check()
                        time.sleep(3)  # 等待图层加载
                        break
        except Exception as e:
            print(f"勾选复选框失败: {e}")

        page.screenshot(path='D:/mycode/NetworkPlanningTooV3/tmp/4_after_check.png')
        print("已截图: 4_after_check.png")

        # 分析控制台日志
        print("\n=== 控制台日志分析 ===")
        online_map_logs = [msg for msg in console_messages if '[OnlineMap]' in msg['text']]
        if online_map_logs:
            print(f"找到 {len(online_map_logs)} 条 OnlineMap 日志:")
            for msg in online_map_logs[-20:]:  # 显示最后20条
                print(f"  [{msg['type']}] {msg['text']}")
        else:
            print("没有找到 [OnlineMap] 日志!")

        # 打印所有错误日志
        error_logs = [msg for msg in console_messages if msg['type'] in ['error', 'warning']]
        if error_logs:
            print(f"\n=== 错误/警告日志 ({len(error_logs)} 条) ===")
            for msg in error_logs[-10:]:
                print(f"  [{msg['type']}] {msg['text']}")

        print("\n按 Enter 关闭浏览器...")
        input()

        browser.close()

if __name__ == '__main__':
    main()
