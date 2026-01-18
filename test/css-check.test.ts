import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

test("src/ui/styles.css .hidden class should have !important", () => {
  const cssPath = join(process.cwd(), "src/ui/styles.css");
  const cssContent = readFileSync(cssPath, "utf-8");

  // Simple regex to find the .hidden rule and check for !important
  const hiddenRuleMatch = cssContent.match(/\.hidden\s*\{[^}]*\}/);
  expect(hiddenRuleMatch).not.toBeNull();
  
  if (hiddenRuleMatch) {
      const ruleBody = hiddenRuleMatch[0];
      expect(ruleBody).toContain("display: none !important");
  }
});
