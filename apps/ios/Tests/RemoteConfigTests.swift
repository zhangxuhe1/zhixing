import XCTest
@testable import Zhixing

/// RemoteConfig 契约：`shareLandingUrl` 在任何 `load()` 之前就已经是内置占位常量（不是 nil/空串）；
/// `load()` 首次调用取 `GET /app-config` 成功则覆盖为服务端值，失败保留占位常量；同一实例内
/// 第二次起调用 `load()` 不再重复请求——以"请求过一次"为界的会话内缓存，不区分首次成功还是失败。
/// 测试缝：`init(fetchConfig:)` 注入假闭包，不发真实网络请求（对齐 FavoritesStore/ViewTracker 写法）。
final class RemoteConfigTests: XCTestCase {
    private actor CallCounter {
        private(set) var count = 0
        func increment() { count += 1 }
    }

    @MainActor
    func testDefaultsToPlaceholderBeforeLoading() {
        let config = RemoteConfig(fetchConfig: { RemoteAppConfig(shareLandingUrl: "https://zx.example/x") })
        XCTAssertEqual(config.shareLandingUrl, RemoteConfig.placeholderShareLandingUrl)
    }

    @MainActor
    func testLoadSuccessOverwritesPlaceholder() async {
        let config = RemoteConfig(fetchConfig: { RemoteAppConfig(shareLandingUrl: "https://zx.example/beta") })

        await config.load()

        XCTAssertEqual(config.shareLandingUrl, "https://zx.example/beta")
    }

    @MainActor
    func testLoadFailureKeepsPlaceholder() async {
        struct Boom: Error {}
        let config = RemoteConfig(fetchConfig: { throw Boom() })

        await config.load()

        XCTAssertEqual(config.shareLandingUrl, RemoteConfig.placeholderShareLandingUrl)
    }

    @MainActor
    func testSecondLoadDoesNotRefetchAfterFailure() async {
        struct Boom: Error {}
        let counter = CallCounter()
        let config = RemoteConfig(fetchConfig: {
            await counter.increment()
            throw Boom()
        })

        await config.load()
        await config.load()

        let count = await counter.count
        XCTAssertEqual(count, 1, "第二次调用应直接返回，不重复请求")
    }

    @MainActor
    func testSecondLoadDoesNotRefetchAfterSuccess() async {
        let counter = CallCounter()
        let config = RemoteConfig(fetchConfig: {
            await counter.increment()
            return RemoteAppConfig(shareLandingUrl: "https://zx.example/beta")
        })

        await config.load()
        await config.load()

        let count = await counter.count
        XCTAssertEqual(count, 1, "第二次调用应直接返回，不重复请求")
    }
}
