// Cloud's `lite.relay.test.ts`, on Lite's copy of the list — plus what Lite adds: the local URL a
// relayed request may be served at (`localRequestUrl`). `npm test`.
import { describe, it } from "node:test"
import assert from "node:assert/strict"
import { normalizeCapabilities, relayCapability } from "./lite-relay"
import { localRequestUrl } from "./lite-relay-url"

describe("relayCapability", () => {
  it("lets the conversations be read", () => {
    assert.equal(relayCapability("GET", "/api/projects"), "read")
    assert.equal(relayCapability("GET", "/api/projects/p1"), "read")
    assert.equal(relayCapability("GET", "/api/projects/p1/tasks"), "read")
    assert.equal(relayCapability("GET", "/api/tasks"), "read")
    assert.equal(relayCapability("GET", "/api/tasks/t_1"), "read")
    assert.equal(relayCapability("GET", "/api/tasks/t_1/events"), "read")
    assert.equal(relayCapability("GET", "/api/tasks/t_1/diff"), "read")
    assert.equal(relayCapability("GET", "/api/tasks/t_1/attachments/a-1"), "read")
  })

  it("puts answering and creating under their own capability", () => {
    for (const action of ["messages", "interrupt", "answer", "validate", "cancel"]) {
      assert.equal(relayCapability("POST", `/api/tasks/t_1/${action}`), "reply", action)
    }
    assert.equal(relayCapability("POST", "/api/projects/p1/tasks"), "create")
  })

  it("relays nothing else", () => {
    assert.equal(relayCapability("GET", "/api/settings"), null)
    assert.equal(relayCapability("GET", "/api/settings/ssh-keys"), null)
    assert.equal(relayCapability("GET", "/api/projects/p1/secrets"), null)
    assert.equal(relayCapability("GET", "/api/secrets"), null)
    assert.equal(relayCapability("GET", "/api/lite-connect"), null)
    assert.equal(relayCapability("DELETE", "/api/tasks/t_1"), null)
    assert.equal(relayCapability("PATCH", "/api/projects/p1"), null)
    assert.equal(relayCapability("POST", "/api/workers"), null)
    assert.equal(relayCapability("GET", "/api/workers/w1/terminal"), null)
    assert.equal(relayCapability("GET", "/api/tasks/t_1/events/extra"), null)
    assert.equal(relayCapability("GET", "/api/tasks/t_1/diff/patch"), null)
    // The method is part of the rule: reading is not answering, answering is not reading.
    assert.equal(relayCapability("POST", "/api/tasks/t_1"), null)
    assert.equal(relayCapability("GET", "/api/tasks/t_1/messages"), null)
    assert.equal(relayCapability("get", "/api/tasks"), null)
  })

  it("refuses a path that would walk out of its rule", () => {
    assert.equal(relayCapability("GET", "/api/tasks/../settings"), null)
    assert.equal(relayCapability("GET", "/api/tasks/a%2F..%2Fsettings"), null)
    assert.equal(relayCapability("GET", "/api/tasks/a%2f"), null)
    assert.equal(relayCapability("GET", "/api/tasks/a%5csettings"), null)
    assert.equal(relayCapability("GET", "/api/tasks/a\\settings"), null)
    assert.equal(relayCapability("GET", "/api/projects/./"), null)
    assert.equal(relayCapability("GET", "/api/projects/.."), null)
    assert.equal(relayCapability("GET", "//evil.example/api/tasks"), null)
    assert.equal(relayCapability("GET", "/api/tasks/t_1?x=/settings"), null)
  })
})

describe("normalizeCapabilities", () => {
  it("keeps the known ones, read when nothing was said", () => {
    assert.deepEqual(normalizeCapabilities(undefined), ["read"])
    assert.deepEqual(normalizeCapabilities(["create", "read", "root"]), ["read", "create"])
    assert.deepEqual(normalizeCapabilities([]), [])
  })
})

describe("localRequestUrl", () => {
  const base = "http://127.0.0.1:3010"
  it("keeps the path and the query of a permitted request", () => {
    assert.equal(localRequestUrl(base, "/api/tasks/t_1/events", "?since=42"), "http://127.0.0.1:3010/api/tasks/t_1/events?since=42")
    assert.equal(localRequestUrl(base, "/api/tasks", ""), "http://127.0.0.1:3010/api/tasks")
    assert.equal(localRequestUrl(base, "/api/tasks", "state=running"), "http://127.0.0.1:3010/api/tasks?state=running")
  })
  it("refuses a query that would change where the request goes", () => {
    assert.equal(localRequestUrl(base, "/api/tasks", "?a=1#/settings"), null)
    assert.equal(localRequestUrl(base, "/api/tasks", "/../settings"), null)
  })
})
