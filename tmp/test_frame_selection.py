"""
测试地图框选功能
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
        print("正在导航到地图页面...")
        page.goto('http://localhost:5173/map')
        page.wait_for_load_state('networkidle')
        time.sleep(2)

        # 截图初始状态
        page.screenshot(path='D:/mycode/NetworkPlanningTooV3/tmp/frame_selection/1_initial.png')
        print("已截图: 1_initial.png")

        # 查找框选控件
        print("\n查找框选控件...")
        try:
            # 尝试找到框选下拉菜单
            frame_select_selectors = [
                'select',  # 下拉选择
                '[role="combobox"]',
            ]

            frame_select_found = False
            for selector in frame_select_selectors:
                elements = page.locator(selector).all()
                print(f"  找到 {len(elements)} 个 {selector} 元素")

                for i, elem in enumerate(elements):
                    try:
                        text = elem.evaluate("el => el.textContent || el.value || ''")
                        print(f"    元素 {i}: {text[:100]}")
                        if '框选' in text or '圈选' in text or '选择' in text:
                            print(f"    -> 找到框选控件!")
                            frame_select_found = True
                            frame_select_element = elem
                            break
                    except:
                        pass

                if frame_select_found:
                    break

            if not frame_select_found:
                print("未找到框选下拉菜单，查找按钮...")
                # 查找按钮形式的框选控件
                buttons = page.locator('button').all()
                print(f"  找到 {len(buttons)} 个按钮")

                for i, btn in enumerate(buttons):
                    try:
                        text = btn.evaluate("el => el.textContent || ''")
                        if '框选' in text or '点选' in text or '圈选' in text:
                            print(f"    按钮 {i}: {text}")
                    except:
                        pass

            # 截图查看当前页面状态
            page.screenshot(path='D:/mycode/NetworkPlanningTooV3/tmp/frame_selection/2_before_selection.png', full_page=True)
            print("\n已截图: 2_before_selection.png")

        except Exception as e:
            print(f"查找框选控件失败: {e}")

        # 尝试勾选一个图层
        print("\n尝试勾选地理化数据图层...")
        checkboxes = page.locator('input[type="checkbox"]').all()
        print(f"找到 {len(checkboxes)} 个复选框")

        geo_layer_checked = False
        for checkbox in checkboxes:
            try:
                label_text = checkbox.evaluate("el => el.parentElement?.textContent || ''")
                if '地理化' in label_text or '图层' in label_text:
                    if not checkbox.is_checked():
                        print(f"  勾选: {label_text[:50]}...")
                        checkbox.check()
                        geo_layer_checked = True
                        time.sleep(2)
                        break
            except:
                pass

        if geo_layer_checked:
            page.screenshot(path='D:/mycode/NetworkPlanningTooV3/tmp/frame_selection/3_layer_loaded.png')
            print("已截图: 3_layer_loaded.png")

        # 分析控制台日志中的框选相关日志
        print("\n=== 框选相关日志分析 ===")
        selection_logs = [msg for msg in console_messages if '框选' in msg['text'] or '圈选' in msg['text'] or 'select' in msg['text'].lower()]
        if selection_logs:
            print(f"找到 {len(selection_logs)} 条相关日志:")
            for msg in selection_logs[-20:]:
                print(f"  [{msg['type']}] {msg['text']}")
        else:
            print("没有找到框选相关日志")

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
