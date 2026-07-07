import XCTest
@testable import Zhixing

final class SmokeTests: XCTestCase {
    func testAppConfigHasAPIBase() {
        XCTAssertTrue(AppConfig.apiBase.absoluteString.hasPrefix("http"))
    }
}
