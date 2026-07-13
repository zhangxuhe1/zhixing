import Foundation
import XCTest
@testable import Zhixing

/// Mac 相册权限的两层回归保护：签名能力必须存在；从系统设置返回后必须重新读取授权状态。
/// 两者都只在 Catalyst 真机环境暴露，iOS 模拟器无法通过真实 TCC 行为覆盖，因此沿用
/// ModalEnvironmentTests 的源码/配置 tripwire 做静态守卫。
final class AlbumImportPermissionTests: XCTestCase {
    private var iosRoot: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
    }

    func testMacEntitlementsAllowPhotoLibraryAccess() throws {
        let url = iosRoot.appendingPathComponent("Zhixing/ZhixingMac.entitlements")
        let data = try Data(contentsOf: url)
        let plist = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])

        XCTAssertEqual(
            plist["com.apple.security.personal-information.photos-library"] as? Bool,
            true,
            "Catalyst 产物缺少 Photos Library entitlement 时，系统设置即使显示已授权，TCC 仍会拒绝访问")
        XCTAssertNil(plist["com.apple.developer.applesignin"],
                     "ad-hoc Catalyst 构建不能携带 Sign in with Apple entitlement")
    }

    func testPermissionScreenRefreshesAfterReturningFromSettings() throws {
        let url = iosRoot.appendingPathComponent("Zhixing/Import/AlbumImportScreen.swift")
        let source = try String(contentsOf: url, encoding: .utf8)

        XCTAssertTrue(source.contains("@Environment(\\.scenePhase)"))
        XCTAssertTrue(source.contains(".onChange(of: scenePhase)"))
        XCTAssertTrue(source.contains("model.needsAuthorizationRefresh"))
        XCTAssertTrue(source.contains(".task(id: scanRequest)"))
        XCTAssertTrue(source.contains("UIApplication.openSettingsURLString"))
    }

    @MainActor
    func testOnlyDeniedAuthorizationNeedsForegroundRefresh() {
        let model = AlbumImportModel()

        XCTAssertFalse(model.needsAuthorizationRefresh)
        model.phase = .denied
        XCTAssertTrue(model.needsAuthorizationRefresh)
        model.phase = .restricted
        XCTAssertFalse(model.needsAuthorizationRefresh)
        model.phase = .review
        XCTAssertFalse(model.needsAuthorizationRefresh)
    }
}
