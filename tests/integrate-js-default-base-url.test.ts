import { describe, it, expect } from "vitest";
import fs from "fs";
import path from "path";
import vm from "vm";

/**
 * Regression test: when integrate.js is loaded from a partner page via
 *   <script src="https://probidcore.net/integrate.js"></script>
 * its default `baseUrl` MUST resolve to ProBidCore's origin, not the
 * partner's origin. Otherwise relative-path fetches (`/api/csrf`,
 * `/api/estimates/send`) hit the partner's own server and the SDK is
 * effectively broken without an explicit `ProBidCore.configure(...)`
 * call — which defeats the "drop-in script" promise.
 *
 * We don't use a real browser here; we just evaluate the SDK file in a
 * Node `vm` context with a tiny `document.currentScript` shim and
 * inspect the URL the SDK passes to `fetch`.
 */

const sdkSource = fs.readFileSync(
  path.resolve(process.cwd(), "client/public/integrate.js"),
  "utf8",
);

function loadSdk(documentMock: any): {
  ProBidCore: any;
  sandbox: any;
} {
  const sandbox: any = {
    URL,
    setTimeout,
    clearTimeout,
    console,
  };
  sandbox.window = sandbox;
  sandbox.document = documentMock;
  vm.createContext(sandbox);
  vm.runInContext(sdkSource, sandbox);
  return { ProBidCore: sandbox.ProBidCore, sandbox };
}

async function captureFirstFetchUrl(
  ProBidCore: any,
  sandbox: any,
): Promise<string> {
  let capturedUrl = "";
  sandbox.fetch = (url: string) => {
    capturedUrl = url;
    return Promise.reject(new Error("stop here"));
  };
  await ProBidCore.sendEstimate({
    name: "x",
    lineItems: [{ description: "y", quantity: 1, unitCost: 1 }],
  }).catch(() => {});
  return capturedUrl;
}

describe("integrate.js default baseUrl detection", () => {
  it("derives the default baseUrl from document.currentScript.src", async () => {
    const { ProBidCore, sandbox } = loadSdk({
      currentScript: { src: "https://probidcore.net/integrate.js" },
      baseURI: "https://partner.example.com/page.html",
      getElementsByTagName: () => [],
    });
    const url = await captureFirstFetchUrl(ProBidCore, sandbox);
    expect(url).toBe("https://probidcore.net/api/csrf");
  });

  it("falls back to scanning <script> tags when currentScript is null", async () => {
    const { ProBidCore, sandbox } = loadSdk({
      currentScript: null,
      baseURI: "https://partner.example.com/page.html",
      getElementsByTagName: (tag: string) =>
        tag === "script"
          ? [
              { src: "https://other.cdn/jquery.js" },
              { src: "https://probidcore.net/integrate.js?v=2" },
            ]
          : [],
    });
    const url = await captureFirstFetchUrl(ProBidCore, sandbox);
    expect(url).toBe("https://probidcore.net/api/csrf");
  });

  it("ProBidCore.configure({ baseUrl }) still wins over the auto-detected origin", async () => {
    const { ProBidCore, sandbox } = loadSdk({
      currentScript: { src: "https://probidcore.net/integrate.js" },
      baseURI: "https://partner.example.com/page.html",
      getElementsByTagName: () => [],
    });
    ProBidCore.configure({ baseUrl: "http://localhost:5000" });
    const url = await captureFirstFetchUrl(ProBidCore, sandbox);
    expect(url).toBe("http://localhost:5000/api/csrf");
  });
});
