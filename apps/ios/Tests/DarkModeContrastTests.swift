import SwiftUI
import XCTest
@testable import Zhixing

/// 深色模式主题护栏：固定品牌填充色不能再次被拿来充当深色表面上的文字或图标色。
final class DarkModeContrastTests: XCTestCase {
    private let minimumNormalTextContrast = 4.5

    func testAdaptiveAccentMeetsContrastOnThemeSurfaces() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            let accent = UIColor(ZXTheme.accent).resolvedColor(with: traits)
            let surfaces = [ZXTheme.canvas, ZXTheme.surface].map {
                UIColor($0).resolvedColor(with: traits)
            }

            for surface in surfaces {
                XCTAssertGreaterThanOrEqual(
                    contrastRatio(accent, surface),
                    minimumNormalTextContrast,
                    "\(style == .dark ? "深色" : "浅色")强调色未达到 WCAG AA 对比度")
            }
        }
    }

    func testAdaptiveAccentActuallyChangesForDarkAppearance() {
        let light = rgba(UIColor(ZXTheme.accent).resolvedColor(
            with: UITraitCollection(userInterfaceStyle: .light)))
        let dark = rgba(UIColor(ZXTheme.accent).resolvedColor(
            with: UITraitCollection(userInterfaceStyle: .dark)))

        XCTAssertNotEqual(light, dark, "强调色必须随系统外观变化，不能退回固定松墨绿")
        XCTAssertGreaterThan(relativeLuminance(dark), relativeLuminance(light))
    }

    func testDesktopSidebarActionsUseWhiteForegroundInDarkAppearance() {
        let darkTraits = UITraitCollection(userInterfaceStyle: .dark)
        for color in [ZXTheme.sidebarAction, ZXTheme.sidebarAccountAction] {
            let components = rgba(UIColor(color).resolvedColor(with: darkTraits))
            XCTAssertEqual(components[0], 1, accuracy: 0.01)
            XCTAssertEqual(components[1], 1, accuracy: 0.01)
            XCTAssertEqual(components[2], 1, accuracy: 0.01)
        }
    }

    func testDesktopSidebarActionsPreserveLightAppearanceHierarchy() {
        let lightTraits = UITraitCollection(userInterfaceStyle: .light)
        let action = rgba(UIColor(ZXTheme.sidebarAction).resolvedColor(with: lightTraits))
        let accent = rgba(UIColor(ZXTheme.accent).resolvedColor(with: lightTraits))
        let account = rgba(UIColor(ZXTheme.sidebarAccountAction).resolvedColor(with: lightTraits))
        let secondary = rgba(UIColor.secondaryLabel.resolvedColor(with: lightTraits))

        XCTAssertEqual(action, accent)
        XCTAssertEqual(account, secondary)
    }

    func testScreenshotControlsUseSemanticDarkModeForegrounds() throws {
        let root = try source(named: "App/RootView.swift")
        let map = try source(named: "Map/MapScreen.swift")

        XCTAssertTrue(root.contains(".tint(ZXTheme.accent)"))
        XCTAssertTrue(root.contains(".foregroundStyle(ZXTheme.sidebarAction)"))
        XCTAssertTrue(root.contains(".foregroundStyle(ZXTheme.sidebarAccountAction)"))
        XCTAssertFalse(root.contains(".tint(ZXTheme.pine)"))
        XCTAssertFalse(map.contains(".foregroundStyle(ZXTheme.pine)"))
    }

    private func source(named relativePath: String) throws -> String {
        let testsDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        let url = testsDirectory.deletingLastPathComponent()
            .appendingPathComponent("Zhixing")
            .appendingPathComponent(relativePath)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func contrastRatio(_ first: UIColor, _ second: UIColor) -> Double {
        let firstLuminance = relativeLuminance(rgba(first))
        let secondLuminance = relativeLuminance(rgba(second))
        return (max(firstLuminance, secondLuminance) + 0.05)
            / (min(firstLuminance, secondLuminance) + 0.05)
    }

    private func relativeLuminance(_ color: UIColor) -> Double {
        relativeLuminance(rgba(color))
    }

    private func relativeLuminance(_ components: [CGFloat]) -> Double {
        let linear = components.prefix(3).map { component -> Double in
            let value = Double(component)
            return value <= 0.04045
                ? value / 12.92
                : pow((value + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]
    }

    private func rgba(_ color: UIColor) -> [CGFloat] {
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        XCTAssertTrue(color.getRed(&red, green: &green, blue: &blue, alpha: &alpha))
        return [red, green, blue, alpha]
    }
}
