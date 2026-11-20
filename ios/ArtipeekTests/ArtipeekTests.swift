import XCTest
@testable import Artipeek

final class ArtipeekTests: XCTestCase {
    func testNormalizeServer() {
        XCTAssertEqual(AppModel.normalize("artipeek.example.com")?.absoluteString, "https://artipeek.example.com")
        XCTAssertEqual(AppModel.normalize(" https://artipeek.example.com/decisions?x=1#y ")?.absoluteString, "https://artipeek.example.com")
        XCTAssertEqual(AppModel.normalize("HTTPS://a.example")?.absoluteString, "https://a.example")
        XCTAssertNil(AppModel.normalize(""))
        XCTAssertNil(AppModel.normalize("ftp://a.example"))
        XCTAssertNil(AppModel.normalize("javascript:alert(1)"))
    }

    func testResolvePushPath() {
        let s = URL(string: "https://artipeek.example.com")
        XCTAssertEqual(AppModel.resolve(path: "/r/erp-desk/decisions#d:erp-desk:D318", on: s)?.absoluteString,
                       "https://artipeek.example.com/r/erp-desk/decisions#d:erp-desk:D318")
        // only paths on the server: never another site
        XCTAssertNil(AppModel.resolve(path: "https://evil.example/x", on: s))
        XCTAssertNil(AppModel.resolve(path: "//evil.example/x", on: s))
        XCTAssertNil(AppModel.resolve(path: nil, on: s))
        XCTAssertNil(AppModel.resolve(path: "/decisions", on: nil))
    }

    func testApsEnvironmentInTests() {
        // the simulator test host has no embedded profile
        XCTAssertEqual(AppModel.apsEnvironment, "production")
    }
}
