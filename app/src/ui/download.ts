/**
 * HAND THE OPERATOR A FILE. One owner, because there were four.
 *
 * `ui/alerts.ts`, `ui/data.ts` and `ui/shell.ts` each carry their own copy of
 * this, two of them with the comment that explains the one line everybody gets
 * wrong. A fifth copy was written for the holdings card and got it wrong in
 * both available ways at once — the anchor was never put in the document and
 * the object URL was revoked on the same tick — so the one thing the card's
 * Export button existed to do almost certainly never happened, with no error
 * anywhere. Nothing could have caught it: a detached anchor has the right
 * href, the right download attribute, and reports a click.
 *
 * Two rules, and they are the whole function:
 *
 *   1. THE ANCHOR MUST BE IN THE DOCUMENT. A click on a detached element
 *      dispatches and downloads nothing.
 *   2. THE REVOKE MUST NOT BE SYNCHRONOUS. Revoking in the same tick can beat
 *      the download the click just started.
 */
export function downloadText(name: string, text: string, type = "application/json"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  /* Hidden rather than merely off-screen: this is in the document for one
     tick and must not reflow anything while it is. */
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  /* One second, matching `ui/alerts.ts`. A frame is enough in every engine
     tested there, and a second costs nothing but a held blob. */
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
