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

final class WatchListTests: XCTestCase {
    // the shape of /decisions/part/app.json (decisions/web.ts appList)
    func testDecodeList() throws {
        let json = """
        {"open":2,"urgent":1,"decisions":[{"project":"work","id":"D4","title":"Ship Friday?","lane":null,"urgent":true,"flagged":false,
        "deadline":"2026-11-21T18:00:00.000Z","createdAt":"2026-11-20T10:00:00.000Z","context":"Crash-free 99.4%","ifNoAnswer":null,
        "questions":[{"key":"","text":"","options":[{"value":"A","label":"Ship","recommended":true},{"value":"B","label":"Wait","recommended":false}]}],
        "lastAnswer":null,"url":"/r/work/decisions#d:work:D4"}]}
        """
        let s = try JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))
        XCTAssertEqual(s.open, 2)
        XCTAssertEqual(s.decisions.first?.key, "work/D4")
        XCTAssertEqual(s.decisions.first?.questions.first?.options.first?.recommended, true)
        XCTAssertNotNil(s.decisions.first?.deadlineDate)
    }

    func testFixedCategoriesMatchServer() {
        let ids = Set(PushCategories.fixed.map(\.identifier))
        XCTAssertEqual(ids, ["artipeek.reply", "artipeek.opts.AB", "artipeek.opts.ABC", "artipeek.opts.ABCD", "artipeek.opts.YN"])
        let ab = PushCategories.fixed.first { $0.identifier == "artipeek.opts.AB" }!
        XCTAssertEqual(ab.actions.map(\.identifier), ["answer.A", "answer.B", "reply", "open"])
    }
}
