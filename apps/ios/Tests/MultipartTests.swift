import XCTest
@testable import Zhixing

final class MultipartTests: XCTestCase {
    func testMultipartBodyLayout() {
        let body = multipartBody(
            boundary: "BOUND", fields: ["lat": "39.94"],
            filename: "p.jpg", mime: "image/jpeg", fileData: Data([0xFF, 0xD8])
        )
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(text.contains("--BOUND\r\ncontent-disposition: form-data; name=\"lat\"\r\n\r\n39.94\r\n"))
        XCTAssertTrue(text.contains("name=\"file\"; filename=\"p.jpg\""))
        XCTAssertTrue(text.contains("content-type: image/jpeg"))
        XCTAssertTrue(text.hasSuffix("\r\n--BOUND--\r\n"))
    }
}
