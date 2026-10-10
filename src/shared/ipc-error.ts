// What the main process threw, as it said it. ipcRenderer.invoke rejects with Electron's own words in front of the
// message ("Error invoking remote method 'live:layerVerify': Error: …"), and the window showed them: a style card read
// "Not verified: Error invoking remote method 'live:layerVerify': Error: Not in the site yet…".

/** The message main threw, without Electron's "Error invoking remote method '<channel>': <Name>: " before it. */
export function mainSaid(message: string): string {
  return message.replace(/^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?/, '');
}
