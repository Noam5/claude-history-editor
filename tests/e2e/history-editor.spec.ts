import fsp from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

test("searches, edits, deletes branches, and blocks stale writes", async ({ page }) => {
  await page.goto("/");

  const search = page.getByLabel("Search all history");
  await search.fill("unique lighthouse");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /unique lighthouse/i }).click();

  const message = page.locator("#message-browser-assistant");
  await expect(message).toContainText("The unique lighthouse sentence is here.");
  await expect(message).toContainText("msg-browser-answer");
  page.once("dialog", (dialog) => dialog.accept());
  await message.getByRole("button", { name: "Randomize", exact: true }).click();
  const messageId = message.locator(".message-id code");
  await expect(messageId).toHaveText(/^msg_01[A-Za-z0-9]{22}$/);
  const randomizedMessageId = await messageId.textContent();
  const randomizedRecords = (await fsp.readFile(
    path.resolve(".e2e-data/history/C--workspace-test/browser-session.jsonl"),
    "utf8"
  ))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(
    randomizedRecords.find((record) => record.uuid === "browser-assistant").message.id
  ).toBe(randomizedMessageId);

  await message.getByRole("button", { name: "Edit" }).click();
  const editor = message.getByLabel("Edit assistant message");
  await editor.fill("The edited lighthouse sentence is here.");
  await message.getByRole("button", { name: "Cancel" }).click();
  await expect(message).toContainText("The unique lighthouse sentence is here.");

  await message.getByRole("button", { name: "Edit" }).click();
  await message.getByLabel("Edit assistant message").fill("The edited lighthouse sentence is here.");
  await message.getByRole("button", { name: "Save message" }).click();
  await expect(message).toContainText("The edited lighthouse sentence is here.");
  await expect(page.getByText(/compressed backup was created/i)).toBeVisible();
  await page.locator(".toast.success button").click();

  await message.getByRole("button", { name: "Edit" }).click();
  await fsp.appendFile(
    path.resolve(".e2e-data/history/C--workspace-test/browser-session.jsonl"),
    `${JSON.stringify({ type: "system", content: "external append" })}\n`
  );
  await message.getByLabel("Edit assistant message").fill("This stale edit must not save.");
  await message.getByRole("button", { name: "Save message" }).click();
  await expect(message.getByText(/session changed after it was loaded/i)).toBeVisible();

  await page.getByRole("button", { name: "Reload" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await message.getByRole("button", { name: "Delete from here" }).click();
  await expect(message).toHaveCount(0);
  await expect(page.getByText(/linked records deleted/i)).toBeVisible();
  await expect(page.getByText(/dependent prompt should be deleted too/i)).toHaveCount(0);
});
