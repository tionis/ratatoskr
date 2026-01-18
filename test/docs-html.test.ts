import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

test("src/ui/docs.html should include prism scripts in correct order", () => {
  const docsPath = join(process.cwd(), "src/ui/docs.html");
  const htmlContent = readFileSync(docsPath, "utf-8");

  const coreIndex = htmlContent.indexOf("prism-core.min.js");
  const markupIndex = htmlContent.indexOf("prism-markup.min.js");
  const clikeIndex = htmlContent.indexOf("prism-clike.min.js");
  const jsIndex = htmlContent.indexOf("prism-javascript.min.js");

  expect(coreIndex).toBeGreaterThan(-1);
  expect(markupIndex).toBeGreaterThan(-1);
  expect(clikeIndex).toBeGreaterThan(-1);
  expect(jsIndex).toBeGreaterThan(-1);

  // Order matters: core -> (markup can be anywhere usually but good to be early) -> clike -> javascript
  expect(coreIndex).toBeLessThan(clikeIndex);
  expect(clikeIndex).toBeLessThan(jsIndex);
});
