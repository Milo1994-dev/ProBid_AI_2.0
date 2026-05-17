import { useEffect } from "react";

interface PageMetaOptions {
  title: string;
  description?: string;
  canonical?: string;
  ogImage?: string;
}

const SITE_NAME = "ProBid AI";
const DEFAULT_OG_IMAGE = "https://probidcore.net/logo.png";

export function usePageMeta({ title, description, canonical, ogImage }: PageMetaOptions) {
  useEffect(() => {
    const fullTitle = title.includes(SITE_NAME) ? title : `${title} | ${SITE_NAME}`;
    document.title = fullTitle;

    const setMeta = (selector: string, attrName: string, attrValue: string, content: string) => {
      let el = document.querySelector(selector);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute(attrName, attrValue);
        document.head.appendChild(el);
      }
      el.setAttribute("content", content);
    };

    if (description) {
      setMeta('meta[name="description"]', "name", "description", description);
      setMeta('meta[property="og:description"]', "property", "og:description", description);
      setMeta('meta[name="twitter:description"]', "name", "twitter:description", description);
    }

    setMeta('meta[property="og:title"]', "property", "og:title", fullTitle);
    setMeta('meta[name="twitter:title"]', "name", "twitter:title", fullTitle);

    const imgSrc = ogImage ?? DEFAULT_OG_IMAGE;
    setMeta('meta[property="og:image"]', "property", "og:image", imgSrc);

    let canonicalEl = document.querySelector('link[rel="canonical"]') as HTMLLinkElement | null;
    if (canonical) {
      if (!canonicalEl) {
        canonicalEl = document.createElement("link");
        canonicalEl.setAttribute("rel", "canonical");
        document.head.appendChild(canonicalEl);
      }
      canonicalEl.href = canonical;
    } else {
      if (canonicalEl) {
        canonicalEl.parentNode?.removeChild(canonicalEl);
      }
    }
  }, [title, description, canonical, ogImage]);
}
