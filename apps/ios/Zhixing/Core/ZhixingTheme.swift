import SwiftUI
import UIKit

/// 知行的统一视觉令牌：取色自宣纸、松墨、石青与朱砂，避免系统默认青色把产品做成通用工具。
enum ZXTheme {
    static let pine = Color(red: 0.08, green: 0.25, blue: 0.21)
    static let pineDeep = Color(red: 0.045, green: 0.15, blue: 0.13)
    static let jade = Color(red: 0.21, green: 0.43, blue: 0.38)
    static let cinnabar = Color(red: 0.72, green: 0.25, blue: 0.18)
    static let mineralBlue = Color(red: 0.22, green: 0.38, blue: 0.43)
    static let oldGold = Color(red: 0.66, green: 0.52, blue: 0.28)
    static let rice = Color(red: 0.96, green: 0.94, blue: 0.88)
    static let ink = Color(red: 0.09, green: 0.12, blue: 0.11)

    static let canvas = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.055, green: 0.07, blue: 0.065, alpha: 1)
            : UIColor(red: 0.965, green: 0.955, blue: 0.925, alpha: 1)
    })

    static let surface = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.10, green: 0.12, blue: 0.11, alpha: 1)
            : UIColor(red: 0.995, green: 0.99, blue: 0.975, alpha: 1)
    })
}

struct ZXPrimaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(.white)
            .padding(.horizontal, 18)
            .frame(minHeight: 48)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(isEnabled ? ZXTheme.pine : ZXTheme.pine.opacity(0.36))
            )
            .opacity(configuration.isPressed ? 0.84 : 1)
            .shadow(color: ZXTheme.pineDeep.opacity(isEnabled ? 0.20 : 0), radius: 12, y: 6)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: configuration.isPressed)
    }
}

struct ZXSecondaryButtonStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(isEnabled ? ZXTheme.pine : .secondary)
            .padding(.horizontal, 16)
            .frame(minHeight: 44)
            .background(
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .fill(ZXTheme.surface.opacity(configuration.isPressed ? 0.72 : 0.96))
            )
            .overlay {
                RoundedRectangle(cornerRadius: 13, style: .continuous)
                    .stroke(ZXTheme.pine.opacity(isEnabled ? 0.22 : 0.10), lineWidth: 1)
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: configuration.isPressed)
    }
}

private struct ZXSurfaceModifier: ViewModifier {
    let radius: CGFloat
    let padding: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(padding)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .stroke(Color.white.opacity(0.42), lineWidth: 1)
            }
            .shadow(color: ZXTheme.ink.opacity(0.10), radius: 22, y: 10)
    }
}

/// 页面级宣纸底色。先把内容撑满导航容器给出的可用区域，再让底色越过安全区；
/// 若直接对空状态或完成态调用 `.background`，底色只会覆盖内容本身的尺寸，宽屏下会形成色块断层。
private struct ZXCanvasBackgroundModifier: ViewModifier {
    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                ZXTheme.canvas.ignoresSafeArea()
            }
    }
}

extension View {
    func zxSurface(radius: CGFloat = 22, padding: CGFloat = 20) -> some View {
        modifier(ZXSurfaceModifier(radius: radius, padding: padding))
    }

    func zxCanvasBackground() -> some View {
        modifier(ZXCanvasBackgroundModifier())
    }
}

struct ZXCategoryBadge: View {
    let text: String

    var body: some View {
        Text(text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(ZXTheme.pine)
            .padding(.horizontal, 9)
            .padding(.vertical, 4)
            .background(ZXTheme.jade.opacity(0.13), in: Capsule())
            .overlay { Capsule().stroke(ZXTheme.jade.opacity(0.18), lineWidth: 1) }
    }
}

struct ZXEmptyState: View {
    let icon: String
    let title: String
    let message: String

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .light))
                .foregroundStyle(ZXTheme.jade)
                .frame(width: 58, height: 58)
                .background(ZXTheme.jade.opacity(0.10), in: Circle())
            Text(title)
                .font(.headline)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineSpacing(3)
        }
        .frame(maxWidth: 420)
        .padding(28)
    }
}

/// 用在列表或分段内容区顶部的空状态。与全屏居中空状态分开，避免数据为空时页面结构突然塌陷。
struct ZXSectionEmptyState: View {
    let icon: String
    let eyebrow: String
    let title: String
    let message: String

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: icon)
                .font(.system(size: 20, weight: .medium))
                .foregroundStyle(ZXTheme.pine)
                .frame(width: 48, height: 48)
                .background(ZXTheme.jade.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))

            VStack(alignment: .leading, spacing: 7) {
                Text(eyebrow)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(ZXTheme.cinnabar)
                Text(title)
                    .font(.system(.headline, design: .serif, weight: .semibold))
                    .foregroundStyle(.primary)
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineSpacing(3)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .zxSurface(radius: 18, padding: 18)
    }
}

struct ZXErrorBanner: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.circle.fill")
            .font(.footnote.weight(.medium))
            .foregroundStyle(ZXTheme.cinnabar)
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(Color(uiColor: .systemBackground).opacity(0.90), in: RoundedRectangle(cornerRadius: 12))
            .overlay {
                RoundedRectangle(cornerRadius: 12)
                    .stroke(ZXTheme.cinnabar.opacity(0.22), lineWidth: 1)
            }
    }
}
