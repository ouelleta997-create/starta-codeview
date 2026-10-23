import { Marked } from "marked";
import DOMPurify from "dompurify";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const md = new Marked({
  gfm: true,
  renderer: {
    code({ text, lang }) {
      const l = (lang ?? "").split(/\s/)[0].toLowerCase();
      return `<div class="codeblock"><div class="cb-head"><span>${esc(l || "texte")}</span><button data-copy>Copier</button></div><pre><code data-lang="${esc(l)}">${esc(text)}</code></pre></div>`;
    },
    link({ href, text }) {
      return `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  },
});

export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(md.parse(src, { async: false }) as string, { ADD_ATTR: ["data-lang", "data-copy", "target"] });
}
