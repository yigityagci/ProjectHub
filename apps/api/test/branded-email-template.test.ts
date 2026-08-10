import { describe, expect, it } from "vitest";
import { renderBrandedEmail } from "../src/email/branded-template.js";

describe("email/branded-template (renderBrandedEmail)", () => {
  it("text output is byte-identical to the input body (plaintext transport/dev console unaffected)", () => {
    const body = "Hi Alice,\n\nSomeone assigned you a task.\n\nView it:\nhttp://localhost:5173/tasks/1\n\n— ProjectHub";
    const { text } = renderBrandedEmail({ subject: "You were assigned a task", body });
    expect(text).toBe(body);
  });

  it("HTML-escapes a user-controlled task title containing a script tag — no raw <script> survives into the html output", () => {
    const maliciousTitle = '<script>alert("xss")</script>';
    const body = `Hi Alice,\n\nSomeone assigned you to "${maliciousTitle}".\n\n— ProjectHub`;
    const { html } = renderBrandedEmail({ subject: "Task assigned", body });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;xss&quot;");
  });

  it("HTML-escapes a malicious subject the same way", () => {
    const { html } = renderBrandedEmail({ subject: '<img src=x onerror=alert(1)>', body: "hello" });
    expect(html).not.toContain("<img src=x onerror=alert(1)>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes ampersands, quotes, and apostrophes exactly once", () => {
    const body = `Workspace "R&D" isn't the same as R&amp;D`;
    const { html } = renderBrandedEmail({ subject: "x", body });
    expect(html).toContain("&quot;R&amp;D&quot; isn&#39;t the same as R&amp;amp;D");
  });

  it("turns a bare http(s) line into a styled CTA anchor with an escaped href", () => {
    const body = "Click below:\n\nhttp://localhost:5173/invite/accept?token=abc123\n\nThanks.";
    const { html } = renderBrandedEmail({ subject: "Invite", body });
    expect(html).toContain('<a href="http://localhost:5173/invite/accept?token=abc123"');
  });

  it("never turns a javascript: URL into a clickable anchor, even alone on its own line", () => {
    const body = "javascript:alert(1)";
    const { html } = renderBrandedEmail({ subject: "x", body });
    expect(html).not.toContain('href="javascript:alert(1)"');
    expect(html).not.toContain("<a href=\"javascript:");
  });

  it("never turns a data: URL into a clickable anchor", () => {
    const body = "data:text/html,<script>alert(1)</script>";
    const { html } = renderBrandedEmail({ subject: "x", body });
    expect(html).not.toContain('<a href="data:');
  });

  it("does turn an https:// URL into a CTA anchor (not just http://)", () => {
    const body = "https://example.com/reset?token=xyz";
    const { html } = renderBrandedEmail({ subject: "x", body });
    expect(html).toContain('<a href="https://example.com/reset?token=xyz"');
  });

  it("a line that is a URL PLUS trailing text is NOT treated as a bare CTA line (rendered as ordinary paragraph text)", () => {
    const body = "Visit http://example.com now";
    const { html } = renderBrandedEmail({ subject: "x", body });
    expect(html).not.toContain('<a href="Visit http://example.com now"');
    expect(html).not.toContain('<a href="http://example.com"');
  });

  it("produces a well-formed HTML document with no external assets referenced", () => {
    const { html } = renderBrandedEmail({ subject: "Test", body: "hello" });
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("ProjectHub");
    expect(html).not.toMatch(/<link\s/i);
    expect(html).not.toMatch(/<script\s/i);
    expect(html).not.toMatch(/src=["']https?:/i);
  });
});
