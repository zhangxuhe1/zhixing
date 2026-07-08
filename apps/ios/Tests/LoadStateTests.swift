import XCTest
@testable import Zhixing

final class LoadStateTests: XCTestCase {
    func testValueIsNilForIdleLoadingAndFailed() {
        let idle: LoadState<Int> = .idle
        let loading: LoadState<Int> = .loading
        let failed: LoadState<Int> = .failed("出错了")
        XCTAssertNil(idle.value)
        XCTAssertNil(loading.value)
        XCTAssertNil(failed.value)
    }

    func testValueUnwrapsLoaded() {
        let loaded: LoadState<[Int]> = .loaded([1, 2, 3])
        XCTAssertEqual(loaded.value, [1, 2, 3])
    }

    func testGenericTransitionIdleToLoadingToLoaded() {
        var state: LoadState<String> = .idle
        XCTAssertNil(state.value)
        state = .loading
        XCTAssertNil(state.value)
        state = .loaded("什刹海")
        XCTAssertEqual(state.value, "什刹海")
    }

    func testGenericTransitionIdleToLoadingToFailed() {
        var state: LoadState<String> = .idle
        state = .loading
        state = .failed("网络异常，请重试")
        XCTAssertNil(state.value)
        guard case let .failed(message) = state else {
            return XCTFail("应处于 failed 态")
        }
        XCTAssertEqual(message, "网络异常，请重试")
    }

    func testRetryTransitionsFailedBackToLoadingThenLoaded() {
        var state: LoadState<Int> = .failed("超时")
        state = .loading // 模拟点击「重试」
        guard case .loading = state else {
            return XCTFail("重试应回到 loading")
        }
        state = .loaded(7)
        XCTAssertEqual(state.value, 7)
    }
}
