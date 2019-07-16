import fastDiff from "fast-diff";
import { TextDocument, TextEdit } from "vscode-languageserver";
import { CLIOptions, TextDocumentSettings } from "./types";
import { URI } from "vscode-uri";
import resolveFrom from "resolve-from";

interface Change {
  start: number;
  end: number;
  newText: string;
}

export function getAllFixEdits(
  textDocument: TextDocument,
  settings: TextDocumentSettings
): TextEdit[] {
  const u = URI.parse(textDocument.uri);
  if (u.scheme != "file") return [];
  const content = textDocument.getText();
  const newOptions: CLIOptions = { ...settings.options, fix: true};
  const filename = URI.parse(textDocument.uri).fsPath;
  const engine = new settings.library.CLIEngine(newOptions);
  const res = engine.executeOnText(content, filename);
  if (!res.results.length) return [];
  const { output } = res.results[0];
  if (output == null) return [];
  const change = getChange(content, output);
  return [
    {
      range: {
        start: textDocument.positionAt(change.start),
        end: textDocument.positionAt(change.end)
      },
      newText: change.newText
    }
  ];
}

export function getChange(oldStr: string, newStr: string): Change {
  const result = fastDiff(oldStr, newStr, 1);
  let curr = 0;
  let start = -1;
  let end = -1;
  let newText = "";
  let remain = "";
  for (const item of result) {
    const [t, str] = item;
    // equal
    if (t == 0) {
      curr += str.length;
      if (start != -1) remain += str;
    } else {
      if (start == -1) start = curr;
      if (t == 1) {
        newText = newText + remain + str;
        end = curr;
      } else {
        newText += remain;
        end = curr + str.length;
      }
      remain = "";
      if (t == -1) curr += str.length;
    }
  }
  return { start, end, newText };
}

export function resolveModule(
  name: string,
  localPath: string,
  globalPath: string
): Promise<string> {
  try {
    const path = resolveFrom(globalPath, name);
    return Promise.resolve(path);
  } catch (error) {
    if (localPath) {
      const path = resolveFrom.silent(localPath, name);
      if (path) return Promise.resolve(path);
    }
    return Promise.reject(error);
  }
}
