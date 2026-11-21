import XCTest
import UserNotifications
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
        // an action's push: the Actions tab, with the #a: jump kept
        XCTAssertEqual(AppModel.resolve(path: "/r/my-desk/actions#a:my-desk:A3", on: s)?.absoluteString,
                       "https://artipeek.example.com/r/my-desk/actions#a:my-desk:A3")
        XCTAssertEqual(AppModel.resolve(path: "/r/my-desk/actions#a:my-desk:A3", on: s)?.fragment, "a:my-desk:A3")
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

    // an older server (before actions): the new fields are absent, the badge is open decisions
    func testDecodeListWithoutActions() throws {
        let json = #"{"open":3,"urgent":0,"decisions":[]}"#
        let s = try JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))
        XCTAssertNil(s.actions)
        XCTAssertEqual(s.forYou, 3)
        XCTAssertEqual(s.urgentAll, 0)
        XCTAssertTrue(s.todo.isEmpty)
    }

    // the actions in /decisions/part/app.json (decisions/web.ts appList, app 1.2)
    func testDecodeActions() throws {
        let json = """
        {"open":1,"urgent":0,"decisions":[],"actionCounts":{"todo":1,"urgent":1,"agent":1},"badge":2,"actions":[
        {"project":"my-desk","id":"A3","title":"Renew the TLS cert","status":"open","lane":null,"urgent":true,"flagged":true,
         "deadline":"2026-11-22T22:00:00.000Z","createdAt":"2026-11-21T10:00:00.000Z","context":"The cert ends Friday.",
         "steps":[{"n":1,"text":"Run certbot on web-1","command":"sudo certbot renew","where":"web-1","state":"verified","note":"seen in the log"},
                  {"n":2,"text":"Check the site","command":null,"where":null,"state":"todo","note":null}],
         "ticked":1,"from":["D317"],"agentAskedAt":null,"agentNote":null,"resolution":null,"url":"/r/my-desk/actions#a:my-desk:A3"},
        {"project":"my-desk","id":"A4","title":"Rotate the key","status":"agent","lane":null,"urgent":false,"flagged":false,"deadline":null,
         "createdAt":"2026-11-21T11:00:00.000Z","context":"","steps":[{"n":1,"text":"Make a key","command":null,"where":null,"state":"todo","note":null}],
         "ticked":0,"from":[],"agentAskedAt":"2026-11-21T11:05:00.000Z","agentNote":"the vault has it","resolution":null,"url":"/r/my-desk/actions#a:my-desk:A4"}]}
        """
        let s = try JSONDecoder().decode(Snapshot.self, from: Data(json.utf8))
        XCTAssertEqual(s.forYou, 2)
        XCTAssertEqual(s.urgentAll, 1)
        XCTAssertEqual(s.todo.map(\.key), ["my-desk/A3"])
        XCTAssertEqual(s.withAgent.map(\.id), ["A4"])
        let a = s.todo[0]
        XCTAssertEqual(a.progress, "1/2")
        XCTAssertEqual(a.from, ["D317"])
        XCTAssertNotNil(a.deadlineDate)
        XCTAssertEqual(a.steps[0].command, "sudo certbot renew")
        XCTAssertEqual(a.steps[0].where, "web-1")
        XCTAssertTrue(a.steps[0].locked)
        XCTAssertFalse(a.steps[1].ticked)
        XCTAssertEqual(s.withAgent[0].agentNote, "the vault has it")
        // a snapshot kept in the Keychain round-trips with its actions
        let again = try JSONDecoder().decode(Snapshot.self, from: JSONEncoder().encode(s))
        XCTAssertEqual(again.allActions, s.allActions)
    }

    // the body of POST /r/<folder>/action (server.ts actionPost)
    func testActionOpBody() {
        XCTAssertEqual(ActionOp.tick(2).body["op"] as? String, "tick")
        XCTAssertEqual(ActionOp.tick(2).body["step"] as? Int, 2)
        XCTAssertEqual(ActionOp.untick(1).body["op"] as? String, "untick")
        XCTAssertEqual(ActionOp.all(note: "ran it at 22:10").body["note"] as? String, "ran it at 22:10")
        XCTAssertNil(ActionOp.all(note: "").body["note"])
        XCTAssertNil(ActionOp.agent(note: nil).body["note"])
        XCTAssertEqual(ActionOp.agent(note: nil).body["op"] as? String, "agent")
    }

    func testFixedCategoriesMatchServer() {
        let ids = Set(PushCategories.fixed.map(\.identifier))
        XCTAssertEqual(ids, ["artipeek.reply", "artipeek.action", "artipeek.opts.AB", "artipeek.opts.ABC", "artipeek.opts.ABCD", "artipeek.opts.YN"])
        let ab = PushCategories.fixed.first { $0.identifier == "artipeek.opts.AB" }!
        XCTAssertEqual(ab.actions.map(\.identifier), ["answer.A", "answer.B", "reply", "open"])
        // an action's push (push/notify.ts category "artipeek.action")
        let act = PushCategories.fixed.first { $0.identifier == PushCategories.action }!
        XCTAssertEqual(act.actions.map(\.identifier), ["agent", "open"])
        XCTAssertTrue(act.actions[0] is UNTextInputNotificationAction)
    }
}
