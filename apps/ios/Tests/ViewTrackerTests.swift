import XCTest
@testable import Zhixing

/// ViewTracker 契约（M2 全局约束：浏览打点失败静默，是全项目唯一允许静默吞错的路径）：
/// 同一 app 会话内，同一 footprintId 至多触发一次 send；不同 id 各自独立触发一次。
/// 用注入的 send 闭包（测试缝 init(send:)）+ actor 计数器验证，不依赖真实网络。
final class ViewTrackerTests: XCTestCase {
    private actor CallRecorder {
        private(set) var calls: [String] = []
        func record(_ id: String) { calls.append(id) }
    }

    @MainActor
    func testSameIdPingedThreeTimesSendsOnlyOnce() async {
        let recorder = CallRecorder()
        let sent = expectation(description: "send 恰好触发一次")
        let tracker = ViewTracker(send: { id in
            await recorder.record(id)
            sent.fulfill()
        })

        tracker.ping(footprintId: "f1")
        tracker.ping(footprintId: "f1")
        tracker.ping(footprintId: "f1")

        await fulfillment(of: [sent], timeout: 2)
        let calls = await recorder.calls
        XCTAssertEqual(calls, ["f1"])
    }

    @MainActor
    func testDifferentIdsEachSendOnce() async {
        let recorder = CallRecorder()
        let sent = expectation(description: "每个不同 id 各触发一次 send")
        sent.expectedFulfillmentCount = 2
        let tracker = ViewTracker(send: { id in
            await recorder.record(id)
            sent.fulfill()
        })

        tracker.ping(footprintId: "f1")
        tracker.ping(footprintId: "f2")

        await fulfillment(of: [sent], timeout: 2)
        let calls = await recorder.calls
        XCTAssertEqual(Set(calls), Set(["f1", "f2"]))
        XCTAssertEqual(calls.count, 2)
    }
}
