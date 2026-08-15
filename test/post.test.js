import test from "node:test";
import assert from "node:assert/strict";
import { isDue, validatePost } from "../src/post.js";

const valid = {
  id: "note-1",
  title: "标题",
  content: "正文",
  images: ["cover.jpg"]
};

test("validatePost normalizes defaults and tags", () => {
  const post = validatePost({ ...valid, tags: ["#旅行", " 生活 "] });
  assert.equal(post.status, "pending");
  assert.deepEqual(post.tags, ["旅行", "生活"]);
});

test("validatePost rejects an overly long title", () => {
  assert.throws(() => validatePost({ ...valid, title: "一".repeat(21) }), /20/);
});

test("isDue handles future and past posts", () => {
  const now = new Date("2026-08-13T12:00:00Z");
  assert.equal(isDue({ status: "pending", publishAt: "2026-08-13T11:00:00Z" }, now), true);
  assert.equal(isDue({ status: "pending", publishAt: "2026-08-13T13:00:00Z" }, now), false);
  assert.equal(isDue({ status: "published" }, now), false);
  assert.equal(isDue({ status: "draft" }, now), false);
  assert.equal(isDue({ status: "cancelled" }, now), false);
});

test("validatePost accepts a cancelled task for queue history", () => {
  assert.equal(validatePost({ ...valid, status: "cancelled" }).status, "cancelled");
});
