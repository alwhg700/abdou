#!/usr/bin/env python3
# أدوات مساعدة على قاعدة Turso عبر HTTP — إدراج/استعلام/تنظيف مهام الاختبار
import json, sys, urllib.request, os

URL = (os.environ.get("TURSO_DATABASE_URL") or "").replace("libsql://", "https://")
TOKEN = os.environ.get("TURSO_AUTH_TOKEN") or os.environ.get("TURSO_TOKEN", "")

def pipeline(reqs):
    body = json.dumps({"requests": reqs}).encode()
    r = urllib.request.Request(URL + "/v2/pipeline", data=body, method="POST",
        headers={"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"})
    with urllib.request.urlopen(r, timeout=30) as resp:
        return json.load(resp)

def execute(sql, args=None):
    stmt = {"sql": sql}
    if args: stmt["args"] = [{"type": t, "value": v} for t, v in args]
    return pipeline([{"type": "execute", "stmt": stmt}, {"type": "close"}])

def rows_of(result):
    out = []
    for rep in result["results"]:
        if rep.get("type") != "ok": continue
        r = rep["response"].get("result", {})
        cols = [c["name"] for c in r.get("cols", [])]
        for row in r.get("rows", []):
            out.append({c: x.get("value") for c, x in zip(cols, row)})
    return out

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "insert-fake-video-tasks":
        # مهمتان مكتملتان لعروسين عامين مختلفين — لاختبار ترتيب task_ids
        t1 = "fakevid-11111111-1111-1111-1111-111111111111"
        t2 = "fakevid-22222222-2222-2222-2222-222222222222"
        u1 = "https://www.w3schools.com/html/mov_bbb.mp4"
        u2 = "https://test-videos.co.uk/vids/bigbuckbunny/mp4/h264/360/Big_Buck_Bunny_360_10s_1MB.mp4"
        execute("INSERT OR REPLACE INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, attempts_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                [("text", t1), ("text", "kie"), ("text", "fake-1"), ("text", "none"), ("text", "grok-imagine-video-1-5-preview"), ("text", "video"), ("text", "مقطع اختبار 1"), ("text", "{}"), ("text", "completed"), ("text", "100"), ("text", json.dumps([u1])), ("text", "[]")])
        execute("INSERT OR REPLACE INTO tasks (id, provider, provider_task_id, key_id, model, type, prompt, params_json, status, progress, result_urls_json, attempts_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
                [("text", t2), ("text", "kie"), ("text", "fake-2"), ("text", "none"), ("text", "grok-imagine-video-1-5-preview"), ("text", "video"), ("text", "مقطع اختبار 2"), ("text", "{}"), ("text", "completed"), ("text", "100"), ("text", json.dumps([u2])), ("text", "[]")])
        print(json.dumps({"t1": t1, "t2": t2}))
    elif cmd == "latest-merge-params":
        r = rows_of(execute("SELECT id, params_json FROM tasks WHERE type='merge' ORDER BY created_at DESC, id DESC LIMIT 1"))
        print(r[0]["params_json"] if r else "{}")
    elif cmd == "cleanup-test":
        # حذف مهام الاختبار (الوهمية + المهام التجريبية بالوصف المعروف)
        for p in ["fakevid-%"]:
            execute("DELETE FROM tasks WHERE id LIKE ?", [("text", p)])
        r = rows_of(execute("SELECT id, prompt FROM tasks"))
        keep, removed = [], 0
        for row in r:
            tid, prompt = row["id"], row.get("prompt") or ""
            if "اختبار" in prompt or prompt.startswith("دمج 2 مقاطع") or "cat astronaut" in prompt:
                execute("DELETE FROM tasks WHERE id = ?", [("text", tid)])
                removed += 1
            else:
                keep.append(tid)
        print(json.dumps({"removed": removed, "kept": keep}))
    elif cmd == "count-tasks":
        r = rows_of(execute("SELECT COUNT(*) AS c FROM tasks"))
        print(r[0]["c"])
    else:
        print("الاستخدام: turso-tools.py [insert-fake-video-tasks|latest-merge-params|cleanup-test|count-tasks]")
