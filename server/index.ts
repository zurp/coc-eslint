/* --------------------------------------------------------------------------------------------
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License. See License.txt in the project root for license information.
 * ------------------------------------------------------------------------------------------ */

"use strict";

import * as os from "os";
import * as path from "path";
import {
  CancellationToken,
  CodeAction,
  CodeActionKind,
  CodeActionRequest,
  Command,
  Diagnostic,
  DiagnosticSeverity,
  DidChangeConfigurationNotification,
  DidChangeWatchedFilesNotification,
  ErrorCodes,
  ExecuteCommandRequest,
  Files,
  IConnection,
  NotificationHandler,
  NotificationType,
  Position,
  Range,
  RequestHandler,
  RequestType,
  ResponseError,
  TextDocument,
  TextDocumentIdentifier,
  TextDocumentSaveReason,
  TextDocumentSyncKind,
  TextDocuments,
  TextEdit,
  VersionedTextDocumentIdentifier,
  WorkspaceChange,
  createConnection
} from "vscode-languageserver";
import { URI } from "vscode-uri";
import {
  CLIOptions,
  ESLintAutoFixEdit,
  ESLintError,
  ESLintModule,
  ESLintProblem,
  ESLintReport,
  Is,
  TextDocumentSettings
} from "./types";
import { getAllFixEdits, resolveModule } from "./util";

declare var __webpack_require__: any;
declare var __non_webpack_require__: any;
const requireFunc =
  typeof __webpack_require__ === "function" ? __non_webpack_require__ : require;

namespace CommandIds {
  export const applySingleFix = "eslint.applySingleFix";
  export const applySameFixes = "eslint.applySameFixes";
  export const applyAllFixes = "eslint.applyAllFixes";
  export const applyAutoFix = "eslint.applyAutoFix";
  export const applyDisableLine = "eslint.applyDisableLine";
  export const applyDisableFile = "eslint.applyDisableFile";
  export const openRuleDoc = "eslint.openRuleDoc";
}

namespace OpenESLintDocRequest {
  export const type = new RequestType<
    OpenESLintDocParams,
    OpenESLintDocResult,
    void,
    void
  >("eslint/openDoc");
}

interface OpenESLintDocParams {
  url: string;
}

interface OpenESLintDocResult {}

enum Status {
  ok = 1,
  warn = 2,
  error = 3
}

interface StatusParams {
  state: Status;
}

namespace StatusNotification {
  export const type = new NotificationType<StatusParams, void>("eslint/status");
}

interface NoConfigParams {
  message: string;
  document: TextDocumentIdentifier;
}

interface NoConfigResult {}

namespace NoConfigRequest {
  export const type = new RequestType<
    NoConfigParams,
    NoConfigResult,
    void,
    void
  >("eslint/noConfig");
}

interface NoESLintLibraryParams {
  source: TextDocumentIdentifier;
}

interface NoESLintLibraryResult {}

namespace NoESLintLibraryRequest {
  export const type = new RequestType<
    NoESLintLibraryParams,
    NoESLintLibraryResult,
    void,
    void
  >("eslint/noLibrary");
}

interface RuleCodeActions {
  fixes: CodeAction[];
  disable?: CodeAction;
  fixAll?: CodeAction;
  disableFile?: CodeAction;
  showDocumentation?: CodeAction;
}

class CodeActionResult {
  private _actions: Map<string, RuleCodeActions>;

  private _fixAll: CodeAction | undefined;

  public constructor() {
    this._actions = new Map();
  }

  public get(ruleId: string): RuleCodeActions {
    let result: RuleCodeActions = this._actions.get(ruleId);
    if (result === undefined) {
      result = { fixes: [] };
      this._actions.set(ruleId, result);
    }
    return result;
  }

  public set fixAll(action: CodeAction) {
    this._fixAll = action;
  }

  public all(): CodeAction[] {
    const result: CodeAction[] = [];
    for (const actions of this._actions.values()) {
      result.push(...actions.fixes);
      if (actions.disable) {
        result.push(actions.disable);
      }
      if (actions.fixAll) {
        result.push(actions.fixAll);
      }
      if (actions.disableFile) {
        result.push(actions.disableFile);
      }
      if (actions.showDocumentation) {
        result.push(actions.showDocumentation);
      }
    }
    if (this._fixAll !== undefined) {
      result.push(this._fixAll);
    }
    return result;
  }

  public get length(): number {
    let result = 0;
    for (const actions of this._actions.values()) {
      result += actions.fixes.length;
    }
    return result;
  }
}

function makeDiagnostic(problem: ESLintProblem): Diagnostic {
  const message =
    problem.ruleId != null
      ? `${problem.message} (${problem.ruleId})`
      : `${problem.message}`;
  const startLine = Math.max(0, problem.line - 1);
  const startChar = Math.max(0, problem.column - 1);
  const endLine =
    problem.endLine != null ? Math.max(0, problem.endLine - 1) : startLine;
  const endChar =
    problem.endColumn != null ? Math.max(0, problem.endColumn - 1) : startChar;
  return {
    message,
    severity: convertSeverity(problem.severity),
    source: "eslint",
    range: {
      start: { line: startLine, character: startChar },
      end: { line: endLine, character: endChar }
    },
    code: problem.ruleId
  };
}

interface FixableProblem {
  label: string;
  documentVersion: number;
  ruleId: string;
  line: number;
  edit?: ESLintAutoFixEdit;
}

function computeKey(diagnostic: Diagnostic): string {
  const range = diagnostic.range;
  return `[${range.start.line},${range.start.character},${range.end.line},${range.end.character}]-${diagnostic.code}`;
}

const codeActions: Map<string, Map<string, FixableProblem>> = new Map<
  string,
  Map<string, FixableProblem>
>();
function recordCodeAction(
  document: TextDocument,
  diagnostic: Diagnostic,
  problem: ESLintProblem
): void {
  if (!problem.ruleId) {
    return;
  }
  const uri = document.uri;
  let edits: Map<string, FixableProblem> = codeActions.get(uri);
  if (!edits) {
    edits = new Map<string, FixableProblem>();
    codeActions.set(uri, edits);
  }
  edits.set(computeKey(diagnostic), {
    label: `Fix this ${problem.ruleId} problem`,
    documentVersion: document.version,
    ruleId: problem.ruleId,
    edit: problem.fix,
    line: problem.line
  });
}

function convertSeverity(severity: number): DiagnosticSeverity {
  switch (severity) {
    // Eslint 1 is warning
    case 1:
      return DiagnosticSeverity.Warning;
    case 2:
      return DiagnosticSeverity.Error;
    default:
      return DiagnosticSeverity.Error;
  }
}

const enum CharCode {
  /**
   * The `\` character.
   */
  Backslash = 92
}

/**
 * Check if the path follows this pattern: `\\hostname\sharename`.
 *
 * @see https://msdn.microsoft.com/en-us/library/gg465305.aspx
 * @return A boolean indication if the path is a UNC path, on none-windows
 * always false.
 */
function isUNC(path: string): boolean {
  if (process.platform !== "win32") {
    // UNC is a windows concept
    return false;
  }

  if (!path || path.length < 5) {
    // at least \\a\b
    return false;
  }

  let code = path.charCodeAt(0);
  if (code !== CharCode.Backslash) {
    return false;
  }
  code = path.charCodeAt(1);
  if (code !== CharCode.Backslash) {
    return false;
  }
  let pos = 2;
  const start = pos;
  for (; pos < path.length; pos++) {
    code = path.charCodeAt(pos);
    if (code === CharCode.Backslash) {
      break;
    }
  }
  if (start === pos) {
    return false;
  }
  code = path.charCodeAt(pos + 1);
  if (isNaN(code) || code === CharCode.Backslash) {
    return false;
  }
  return true;
}

function getFileSystemPath(uri: URI): string {
  const result = uri.fsPath;
  if (process.platform === "win32" && result.length >= 2 && result[1] === ":") {
    // Node by default uses an upper case drive letter and ESLint uses
    // === to compare pathes which results in the equal check failing
    // if the drive letter is lower case in th URI. Ensure upper case.
    return result[0].toUpperCase() + result.substr(1);
  }
  return result;
}

function getFilePath(documentOrUri: string | TextDocument): string {
  if (!documentOrUri) {
    return undefined;
  }
  const uri = Is.string(documentOrUri)
    ? URI.parse(documentOrUri)
    : URI.parse(documentOrUri.uri);
  if (uri.scheme !== "file") {
    return undefined;
  }
  return getFileSystemPath(uri);
}

const exitCalled = new NotificationType<[number, string], void>(
  "eslint/exitCalled"
);

const nodeExit = process.exit;
process.exit = ((code?: number): void => {
  const stack = new Error("stack");
  connection.sendNotification(exitCalled, [code ? code : 0, stack.stack]);
  setTimeout(() => {
    nodeExit(code);
  }, 1000);
}) as any;
process.on("uncaughtException", (error: any) => {
  let message: string;
  if (error) {
    if (typeof error.stack === "string") {
      message = error.stack;
    } else if (typeof error.message === "string") {
      message = error.message;
    } else if (typeof error === "string") {
      message = error;
    }
    if (!message) {
      try {
        message = JSON.stringify(error, undefined, 4);
      } catch (error2) {
        // Should not happen.
      }
    }
  }
  connection.console.error(`Uncaught exception recevied.
  ${message || ""}`);
});

const connection = createConnection();
connection.console.info(`ESLint server running in node ${process.version}`);
const documents: TextDocuments = new TextDocuments();

let _globalNpmPath: string | null | undefined;
function globalNpmPath(): string {
  if (_globalNpmPath === void 0) {
    _globalNpmPath = Files.resolveGlobalNodePath(trace);
    if (_globalNpmPath === void 0) {
      _globalNpmPath = null;
    }
  }
  if (_globalNpmPath === null) {
    return undefined;
  }
  return _globalNpmPath;
}
let _globalYarnPath: string | undefined;
function globalYarnPath(): string {
  if (_globalYarnPath === void 0) {
    _globalYarnPath = Files.resolveGlobalYarnPath(trace);
    if (_globalYarnPath === void 0) {
      _globalYarnPath = null;
    }
  }
  if (_globalYarnPath === null) {
    return undefined;
  }
  return _globalYarnPath;
}
const path2Library: Map<string, ESLintModule> = new Map<string, ESLintModule>();
const document2Settings: Map<string, Thenable<TextDocumentSettings>> = new Map<
  string,
  Thenable<TextDocumentSettings>
>();

const ruleDocData: {
  handled: Set<string>;
  urls: Map<string, string>;
} = {
  handled: new Set<string>(),
  urls: new Map<string, string>()
};

function resolveSettings(
  document: TextDocument
): Thenable<TextDocumentSettings> {
  const uri = document.uri;
  let resultPromise = document2Settings.get(uri);
  if (resultPromise) {
    return resultPromise;
  }
  resultPromise = connection.workspace
    .getConfiguration({ scopeUri: uri, section: "" })
    .then((settings: TextDocumentSettings) => {
      let nodePath: string;
      if (settings.nodePath) {
        nodePath = settings.nodePath;
        if (nodePath.startsWith("~")) {
          nodePath = nodePath.replace(/^~/, os.homedir());
        }
        if (!path.isAbsolute(nodePath)) {
          nodePath = path.join(
            URI.parse(settings.workspaceFolder.uri).fsPath,
            nodePath
          );
        }
      } else if (settings.packageManager === "npm") {
        nodePath = globalNpmPath();
      } else if (settings.packageManager === "yarn") {
        nodePath = globalYarnPath();
      }
      const uri = URI.parse(document.uri);
      let promise: Thenable<string>;
      let directory: string;
      if (uri.scheme === "file") {
        directory = path.dirname(uri.fsPath);
      } else {
        directory = settings.workspaceFolder
          ? URI.parse(settings.workspaceFolder.uri).fsPath
          : undefined;
      }
      promise = resolveModule("eslint", directory, nodePath);
      return promise.then(
        path => {
          let library = path2Library.get(path);
          if (!library) {
            library = requireFunc(path);
            if (!library.CLIEngine) {
              settings.validate = false;
              connection.console.error(
                `The eslint library loaded from ${path} doesn\'t export a CLIEngine. You need at least eslint@1.0.0`
              );
            } else {
              connection.console.info(`ESLint library loaded from: ${path}`);
              settings.library = library;
            }
            path2Library.set(path, library);
          } else {
            settings.library = library;
          }
          return settings;
        },
        () => {
          settings.validate = false;
          connection.sendRequest(NoESLintLibraryRequest.type, {
            source: { uri: document.uri }
          });
          return settings;
        }
      );
    });
  document2Settings.set(uri, resultPromise);
  return resultPromise;
}

interface Request<P, R> {
  method: string;
  params: P;
  documentVersion: number | undefined;
  resolve: (value: R | Thenable<R>) => void | undefined;
  reject: (error: any) => void | undefined;
  token: CancellationToken | undefined;
}

namespace Request {
  export function is(value: any): value is Request<any, any> {
    const candidate: Request<any, any> = value;
    return (
      candidate &&
      Boolean(candidate.token) &&
      Boolean(candidate.resolve) &&
      Boolean(candidate.reject)
    );
  }
}

interface Notifcation<P> {
  method: string;
  params: P;
  documentVersion: number;
}

type Message<P, R> = Notifcation<P> | Request<P, R>;

type VersionProvider<P> = (params: P) => number;

namespace Thenable {
  export function is<T>(value: any): value is Thenable<T> {
    const candidate: Thenable<T> = value;
    return candidate && typeof candidate.then === "function";
  }
}

class BufferedMessageQueue {
  private queue: Message<any, any>[];

  private requestHandlers: Map<
    string,
    {
      handler: RequestHandler<any, any, any>;
      versionProvider?: VersionProvider<any>;
    }
  >;

  private notificationHandlers: Map<
    string,
    {
      handler: NotificationHandler<any>;
      versionProvider?: VersionProvider<any>;
    }
  >;

  private timer: NodeJS.Immediate | undefined;

  constructor(private connection: IConnection) {
    this.queue = [];
    this.requestHandlers = new Map();
    this.notificationHandlers = new Map();
  }

  public registerRequest<P, R, E, RO>(
    type: RequestType<P, R, E, RO>,
    handler: RequestHandler<P, R, E>,
    versionProvider?: VersionProvider<P>
  ): void {
    this.connection.onRequest(type, (params, token) => {
      return new Promise<R>((resolve, reject) => {
        this.queue.push({
          method: type.method,
          params,
          documentVersion: versionProvider
            ? versionProvider(params)
            : undefined,
          resolve,
          reject,
          token
        });
        this.trigger();
      });
    });
    this.requestHandlers.set(type.method, { handler, versionProvider });
  }

  public registerNotification<P, RO>(
    type: NotificationType<P, RO>,
    handler: NotificationHandler<P>,
    versionProvider?: (params: P) => number
  ): void {
    connection.onNotification(type, params => {
      this.queue.push({
        method: type.method,
        params,
        documentVersion: versionProvider ? versionProvider(params) : undefined
      });
      this.trigger();
    });
    this.notificationHandlers.set(type.method, { handler, versionProvider });
  }

  public addNotificationMessage<P, RO>(
    type: NotificationType<P, RO>,
    params: P,
    version: number
  ): void {
    this.queue.push({
      method: type.method,
      params,
      documentVersion: version
    });
    this.trigger();
  }

  public onNotification<P, RO>(
    type: NotificationType<P, RO>,
    handler: NotificationHandler<P>,
    versionProvider?: (params: P) => number
  ): void {
    this.notificationHandlers.set(type.method, { handler, versionProvider });
  }

  private trigger(): void {
    if (this.timer || this.queue.length === 0) {
      return;
    }
    this.timer = setImmediate(() => {
      this.timer = undefined;
      this.processQueue();
    });
  }

  private processQueue(): void {
    const message = this.queue.shift();
    if (!message) {
      return;
    }
    if (Request.is(message)) {
      const requestMessage = message;
      if (requestMessage.token.isCancellationRequested) {
        requestMessage.reject(
          // tslint:disable-next-line: no-inferred-empty-object-type
          new ResponseError(
            ErrorCodes.RequestCancelled,
            "Request got cancelled"
          )
        );
        return;
      }
      const elem = this.requestHandlers.get(requestMessage.method);
      if (
        elem.versionProvider &&
        requestMessage.documentVersion !== void 0 &&
        requestMessage.documentVersion !==
          elem.versionProvider(requestMessage.params)
      ) {
        requestMessage.reject(
          // tslint:disable-next-line: no-inferred-empty-object-type
          new ResponseError(
            ErrorCodes.RequestCancelled,
            "Request got cancelled"
          )
        );
        return;
      }
      const result = elem.handler(requestMessage.params, requestMessage.token);
      if (Thenable.is(result)) {
        result.then(
          value => {
            requestMessage.resolve(value);
          },
          error => {
            requestMessage.reject(error);
          }
        );
      } else {
        requestMessage.resolve(result);
      }
    } else {
      const notificationMessage = message;
      const elem = this.notificationHandlers.get(notificationMessage.method);
      if (
        elem.versionProvider &&
        notificationMessage.documentVersion !== void 0 &&
        notificationMessage.documentVersion !==
          elem.versionProvider(notificationMessage.params)
      ) {
        return;
      }
      elem.handler(notificationMessage.params);
    }
    this.trigger();
  }
}

const messageQueue: BufferedMessageQueue = new BufferedMessageQueue(connection);

namespace ValidateNotification {
  export const type: NotificationType<
    TextDocument,
    void
  > = new NotificationType<TextDocument, void>("eslint/validate");
}

messageQueue.onNotification(
  ValidateNotification.type,
  document => {
    validateSingle(document, true);
  },
  (document): number => {
    return document.version;
  }
);

// The documents manager listen for text document create, change
// and close on the connection
documents.listen(connection);
documents.onDidOpen(event => {
  resolveSettings(event.document).then(settings => {
    if (!settings.validate) {
      return;
    }
    if (settings.run === "onSave") {
      messageQueue.addNotificationMessage(
        ValidateNotification.type,
        event.document,
        event.document.version
      );
    }
  });
});

// A text document has changed. Validate the document according the run setting.
documents.onDidChangeContent(event => {
  resolveSettings(event.document).then(settings => {
    if (!settings.validate || settings.run !== "onType") {
      return;
    }
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      event.document,
      event.document.version
    );
  });
});

documents.onWillSaveWaitUntil(event => {
  if (event.reason === TextDocumentSaveReason.AfterDelay) {
    return [];
  }

  const document = event.document;
  return resolveSettings(document).then(settings => {
    if (!settings.autoFixOnSave) {
      return [];
    }
    // If we validate on save and want to apply fixes on will save
    // we need to validate the file.
    if (settings.run === "onSave") {
      // Do not queue this since we want to get the fixes as fast as possible.
      return validateSingle(document, false).then(() =>
        getAllFixEdits(document, settings)
      );
    }
    return getAllFixEdits(document, settings);
  });
});

// A text document has been saved. Validate the document according the run setting.
documents.onDidSave(event => {
  resolveSettings(event.document).then(settings => {
    if (!settings.validate || settings.run !== "onSave") {
      return;
    }
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      event.document,
      event.document.version
    );
  });
});

documents.onDidClose(event => {
  resolveSettings(event.document).then(settings => {
    const uri = event.document.uri;
    document2Settings.delete(uri);
    codeActions.delete(uri);
    if (settings.validate) {
      connection.sendDiagnostics({ uri, diagnostics: [] });
    }
  });
});

function environmentChanged(): void {
  document2Settings.clear();
  for (const document of documents.all()) {
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      document,
      document.version
    );
  }
}

function trace(message: string, verbose?: string): void {
  connection.tracer.log(message, verbose);
}

connection.onInitialize(_params => {
  return {
    capabilities: {
      textDocumentSync: {
        openClose: true,
        change: TextDocumentSyncKind.Full,
        willSaveWaitUntil: true,
        save: {
          includeText: false
        }
      },
      codeActionProvider: true,
      executeCommandProvider: {
        commands: [
          CommandIds.applySingleFix,
          CommandIds.applySameFixes,
          CommandIds.applyAllFixes,
          CommandIds.applyAutoFix,
          CommandIds.applyDisableLine,
          CommandIds.applyDisableFile,
          CommandIds.openRuleDoc
        ]
      }
    }
  };
});

connection.onInitialized(() => {
  connection.client.register(
    DidChangeConfigurationNotification.type,
    undefined
  );
});

messageQueue.registerNotification(
  DidChangeConfigurationNotification.type,
  _params => {
    environmentChanged();
  }
);

// messageQueue.registerNotification(
//   DidChangeWorkspaceFoldersNotification.type,
//   _params => {
//     environmentChanged()
//   }
// )

const singleErrorHandlers: ((
  error: any,
  document: TextDocument,
  library: ESLintModule
) => Status)[] = [
  tryHandleNoConfig,
  tryHandleConfigError,
  tryHandleMissingModule,
  showErrorMessage
];

function validateSingle(
  document: TextDocument,
  publishDiagnostics = true
): Thenable<void> {
  // We validate document in a queue but open / close documents directly. So we need to deal with the
  // fact that a document might be gone from the server.
  if (!documents.get(document.uri)) {
    return Promise.resolve(undefined);
  }
  return resolveSettings(document).then(settings => {
    if (!settings.validate) {
      return;
    }
    try {
      validate(document, settings, publishDiagnostics);
      connection.sendNotification(StatusNotification.type, {
        state: Status.ok
      });
    } catch (error) {
      let status;
      for (const handler of singleErrorHandlers) {
        status = handler(error, document, settings.library);
        if (status) {
          break;
        }
      }
      status = status || Status.error;
      connection.sendNotification(StatusNotification.type, { state: status });
    }
  });
}

function validateMany(documents: TextDocument[]): void {
  documents.forEach(document => {
    messageQueue.addNotificationMessage(
      ValidateNotification.type,
      document,
      document.version
    );
  });
}

function getMessage(err: any, document: TextDocument): string {
  let result: string = null;
  if (typeof err.message === "string" || err.message instanceof String) {
    result = err.message as string;
    result = result.replace(/\r?\n/g, " ");
    if (result.startsWith("CLI: ")) {
      result = result.substr(5);
    }
  } else {
    result = `An unknown error occured while validating document: ${document.uri}`;
  }
  return result;
}

function validate(
  document: TextDocument,
  settings: TextDocumentSettings,
  publishDiagnostics = true
): void {
  const newOptions: CLIOptions = Object.assign(
    Object.create(null),
    settings.options
  );
  const content = document.getText();
  const uri = document.uri;
  const file = getFilePath(document);
  const cwd = process.cwd();

  try {
    if (file) {
      if (settings.workingDirectory) {
        newOptions.cwd = settings.workingDirectory.directory;
        if (settings.workingDirectory.changeProcessCWD) {
          process.chdir(settings.workingDirectory.directory);
        }
      } else if (settings.workspaceFolder) {
        const workspaceFolderUri = URI.parse(settings.workspaceFolder.uri);
        if (workspaceFolderUri.scheme === "file") {
          const fsPath = getFileSystemPath(workspaceFolderUri);
          newOptions.cwd = fsPath;
          process.chdir(fsPath);
        }
      } else if (!settings.workspaceFolder && !isUNC(file)) {
        const directory = path.dirname(file);
        if (directory) {
          if (path.isAbsolute(directory)) {
            newOptions.cwd = directory;
          }
        }
      }
    }

    const cli = new settings.library.CLIEngine(newOptions);
    // Clean previously computed code actions.
    codeActions.delete(uri);
    const report: ESLintReport = cli.executeOnText(content, file);
    const diagnostics: Diagnostic[] = [];
    if (
      report &&
      report.results &&
      Array.isArray(report.results) &&
      report.results.length > 0
    ) {
      const docReport = report.results[0];
      if (docReport.messages && Array.isArray(docReport.messages)) {
        docReport.messages.forEach(problem => {
          if (problem) {
            const isWarning =
              convertSeverity(problem.severity) === DiagnosticSeverity.Warning;
            if (settings.quiet && isWarning) {
              // Filter out warnings when quiet mode is enabled
              return;
            }
            const diagnostic = makeDiagnostic(problem);
            diagnostics.push(diagnostic);
            if (settings.autoFix) {
              if (
                typeof cli.getRules === "function" &&
                problem.ruleId !== undefined &&
                problem.fix !== undefined
              ) {
                const rule = cli.getRules().get(problem.ruleId);
                if (
                  rule !== undefined &&
                  rule.meta &&
                  typeof rule.meta.fixable === "string"
                ) {
                  recordCodeAction(document, diagnostic, problem);
                }
              } else {
                recordCodeAction(document, diagnostic, problem);
              }
            }
          }
        });
      }
    }
    if (publishDiagnostics) {
      connection.sendDiagnostics({ uri, diagnostics });
    }

    // cache documentation urls for all rules
    if (typeof cli.getRules === "function" && !ruleDocData.handled.has(uri)) {
      ruleDocData.handled.add(uri);
      cli.getRules().forEach((rule, key) => {
        if (rule.meta && rule.meta.docs && Is.string(rule.meta.docs.url)) {
          ruleDocData.urls.set(key, rule.meta.docs.url);
        }
      });
    }
  } finally {
    if (cwd !== process.cwd()) {
      process.chdir(cwd);
    }
  }
}
let noConfigReported: Map<string, ESLintModule> = new Map<
  string,
  ESLintModule
>();

function isNoConfigFoundError(error: any): boolean {
  const candidate = error as ESLintError;
  return (
    candidate.messageTemplate === "no-config-found" ||
    candidate.message === "No ESLint configuration found."
  );
}

function tryHandleNoConfig(
  error: any,
  document: TextDocument,
  library: ESLintModule
): Status {
  if (!isNoConfigFoundError(error)) {
    return undefined;
  }
  if (!noConfigReported.has(document.uri)) {
    connection
      .sendRequest(NoConfigRequest.type, {
        message: getMessage(error, document),
        document: {
          uri: document.uri
        }
      })
      .then(undefined, () => {
        // noop
      });
    noConfigReported.set(document.uri, library);
  }
  return Status.warn;
}

const configErrorReported: Map<string, ESLintModule> = new Map<
  string,
  ESLintModule
>();

function tryHandleConfigError(
  error: any,
  document: TextDocument,
  library: ESLintModule
): Status {
  if (!error.message) {
    return undefined;
  }

  function handleFileName(filename: string): Status {
    if (!configErrorReported.has(filename)) {
      connection.console.error(getMessage(error, document));
      if (!documents.get(URI.file(filename).toString())) {
        connection.window.showInformationMessage(getMessage(error, document));
      }
      configErrorReported.set(filename, library);
    }
    return Status.warn;
  }

  let matches = /Cannot read config file:\s+(.*)\nError:\s+(.*)/.exec(
    error.message
  );
  if (matches && matches.length === 3) {
    return handleFileName(matches[1]);
  }

  matches = /(.*):\n\s*Configuration for rule "(.*)" is /.exec(error.message);
  if (matches && matches.length === 3) {
    return handleFileName(matches[1]);
  }

  matches = /Cannot find module '([^']*)'\nReferenced from:\s+(.*)/.exec(
    error.message
  );
  if (matches && matches.length === 3) {
    return handleFileName(matches[2]);
  }

  return undefined;
}

let missingModuleReported: Map<string, ESLintModule> = new Map<
  string,
  ESLintModule
>();

function tryHandleMissingModule(
  error: any,
  document: TextDocument,
  library: ESLintModule
): Status {
  if (!error.message) {
    return undefined;
  }

  function handleMissingModule(
    plugin: string,
    module: string,
    error: ESLintError
  ): Status {
    if (!missingModuleReported.has(plugin)) {
      const fsPath = getFilePath(document);
      missingModuleReported.set(plugin, library);
      if (error.messageTemplate === "plugin-missing") {
        connection.console.error(
          [
            "",
            `${error.message.toString()}`,
            `Happened while validating ${fsPath ? fsPath : document.uri}`,
            `This can happen for a couple of reasons:`,
            `1. The plugin name is spelled incorrectly in an ESLint configuration file (e.g. .eslintrc).`,
            `2. If ESLint is installed globally, then make sure ${module} is installed globally as well.`,
            `3. If ESLint is installed locally, then ${module} isn't installed correctly.`,
            "",
            `Consider running eslint --debug ${
              fsPath ? fsPath : document.uri
            } from a terminal to obtain a trace about the configuration files used.`
          ].join("\n")
        );
      } else {
        connection.console.error(
          [
            `${error.message.toString()}`,
            `Happend while validating ${fsPath ? fsPath : document.uri}`
          ].join("\n")
        );
      }
    }
    return Status.warn;
  }

  const matches = /Failed to load plugin (.*): Cannot find module (.*)/.exec(
    error.message
  );
  if (matches && matches.length === 3) {
    return handleMissingModule(matches[1], matches[2], error);
  }

  return undefined;
}

function showErrorMessage(error: any, document: TextDocument): Status {
  connection.window.showErrorMessage(
    `ESLint: ${getMessage(
      error,
      document
    )}. Please see the 'ESLint' output channel for details.`
  );
  if (Is.string(error.stack)) {
    connection.console.error("ESLint stack trace:");
    connection.console.error(error.stack);
  }
  return Status.error;
}

messageQueue.registerNotification(
  DidChangeWatchedFilesNotification.type,
  params => {
    // A .eslintrc has change. No smartness here.
    // Simply revalidate all file.
    noConfigReported = new Map<string, ESLintModule>();
    missingModuleReported = new Map<string, ESLintModule>();
    params.changes.forEach(change => {
      const fsPath = getFilePath(change.uri);
      if (!fsPath || isUNC(fsPath)) {
        return;
      }
      const dirname = path.dirname(fsPath);
      if (dirname) {
        const library = configErrorReported.get(fsPath);
        if (library) {
          const cli = new library.CLIEngine({});
          try {
            cli.executeOnText("", path.join(dirname, "___test___.js"));
            configErrorReported.delete(fsPath);
          } catch (error) {
            // noop
          }
        }
      }
    });
    validateMany(documents.all());
  }
);

class Fixes {
  constructor(private edits: Map<string, FixableProblem>) {}

  public static overlaps(
    lastEdit: FixableProblem,
    newEdit: FixableProblem
  ): boolean {
    return Boolean(lastEdit) && lastEdit.edit.range[1] > newEdit.edit.range[0];
  }

  public isEmpty(): boolean {
    return this.edits.size === 0;
  }

  public getDocumentVersion(): number {
    if (this.isEmpty()) {
      throw new Error("No edits recorded.");
    }
    return this.edits.values().next().value.documentVersion;
  }

  public getScoped(diagnostics: Diagnostic[]): FixableProblem[] {
    const result: FixableProblem[] = [];
    for (const diagnostic of diagnostics) {
      const key = computeKey(diagnostic);
      const editInfo = this.edits.get(key);
      if (editInfo) {
        result.push(editInfo);
      }
    }
    return result;
  }

  public getAllSorted(): FixableProblem[] {
    const result: FixableProblem[] = [];
    this.edits.forEach(value => result.push(value));
    return result.sort((a, b) => {
      const d = a.edit.range[0] - b.edit.range[0];
      if (d !== 0) {
        return d;
      }
      if (a.edit.range[1] === 0) {
        return -1;
      }
      if (b.edit.range[1] === 0) {
        return 1;
      }
      return a.edit.range[1] - b.edit.range[1];
    });
  }

  public getOverlapFree(): FixableProblem[] {
    const sorted = this.getAllSorted();
    if (sorted.length <= 1) {
      return sorted;
    }
    const result: FixableProblem[] = [];
    let last: FixableProblem = sorted[0];
    result.push(last);
    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      if (!Fixes.overlaps(last, current)) {
        result.push(current);
        last = current;
      }
    }
    return result;
  }
}

let commands: Map<string, WorkspaceChange>;
messageQueue.registerRequest(
  CodeActionRequest.type,
  params => {
    commands = new Map<string, WorkspaceChange>();
    const result: CodeActionResult = new CodeActionResult();
    const uri = params.textDocument.uri;
    const edits = codeActions.get(uri);
    if (!edits) return [];
    const fixes = new Fixes(edits);
    if (fixes.isEmpty()) return [];

    const textDocument = documents.get(uri);
    let documentVersion = -1;
    const allFixableRuleIds: string[] = [];

    function createTextEdit(editInfo: FixableProblem): TextEdit {
      return TextEdit.replace(
        Range.create(
          textDocument.positionAt(editInfo.edit.range[0]),
          textDocument.positionAt(editInfo.edit.range[1])
        ),
        editInfo.edit.text || ""
      );
    }

    function createDisableLineTextEdit(
      editInfo: FixableProblem,
      indentationText: string
    ): TextEdit {
      return TextEdit.insert(
        Position.create(editInfo.line - 1, 0),
        `${indentationText}// eslint-disable-next-line ${editInfo.ruleId}\n`
      );
    }

    function createDisableSameLineTextEdit(editInfo: FixableProblem): TextEdit {
      return TextEdit.insert(
        Position.create(editInfo.line - 1, Number.MAX_VALUE),
        ` // eslint-disable-line ${editInfo.ruleId}`
      );
    }

    function createDisableFileTextEdit(editInfo: FixableProblem): TextEdit {
      return TextEdit.insert(
        Position.create(0, 0),
        `/* eslint-disable ${editInfo.ruleId} */\n`
      );
    }

    function getLastEdit(array: FixableProblem[]): FixableProblem {
      const length = array.length;
      if (length === 0) {
        return undefined;
      }
      return array[length - 1];
    }

    return resolveSettings(textDocument).then(settings => {
      for (const editInfo of fixes.getScoped(params.context.diagnostics)) {
        documentVersion = editInfo.documentVersion;
        const ruleId = editInfo.ruleId;
        allFixableRuleIds.push(ruleId);

        if (editInfo.edit) {
          const workspaceChange = new WorkspaceChange();
          workspaceChange
            .getTextEditChange({ uri, version: documentVersion })
            .add(createTextEdit(editInfo));
          commands.set(
            `${CommandIds.applySingleFix}:${ruleId}`,
            workspaceChange
          );
          result
            .get(ruleId)
            .fixes.push(
              CodeAction.create(
                editInfo.label,
                Command.create(
                  editInfo.label,
                  CommandIds.applySingleFix,
                  ruleId
                ),
                CodeActionKind.QuickFix
              )
            );
        }

        if (settings.codeAction.disableRuleComment.enable) {
          let workspaceChange = new WorkspaceChange();
          if (settings.codeAction.disableRuleComment.location === "sameLine") {
            workspaceChange
              .getTextEditChange({ uri, version: documentVersion })
              .add(createDisableSameLineTextEdit(editInfo));
          } else {
            const lineText = textDocument.getText(
              Range.create(
                Position.create(editInfo.line - 1, 0),
                Position.create(editInfo.line - 1, Number.MAX_VALUE)
              )
            );
            const indentationText = /^([\t ]*)/.exec(lineText)[1];
            workspaceChange
              .getTextEditChange({ uri, version: documentVersion })
              .add(createDisableLineTextEdit(editInfo, indentationText));
          }
          commands.set(
            `${CommandIds.applyDisableLine}:${ruleId}`,
            workspaceChange
          );
          let title = `Disable ${ruleId} for this line`;
          result.get(ruleId).disable = CodeAction.create(
            title,
            Command.create(title, CommandIds.applyDisableLine, ruleId),
            CodeActionKind.QuickFix
          );

          if (result.get(ruleId).disableFile === undefined) {
            workspaceChange = new WorkspaceChange();
            workspaceChange
              .getTextEditChange({ uri, version: documentVersion })
              .add(createDisableFileTextEdit(editInfo));
            commands.set(
              `${CommandIds.applyDisableFile}:${ruleId}`,
              workspaceChange
            );
            title = `Disable ${ruleId} for the entire file`;
            result.get(ruleId).disableFile = CodeAction.create(
              title,
              Command.create(title, CommandIds.applyDisableFile, ruleId),
              CodeActionKind.QuickFix
            );
          }
        }

        if (
          settings.codeAction.showDocumentation.enable &&
          result.get(ruleId).showDocumentation === undefined
        ) {
          if (ruleDocData.urls.has(ruleId)) {
            const title = `Show documentation for ${ruleId}`;
            result.get(ruleId).showDocumentation = CodeAction.create(
              title,
              Command.create(title, CommandIds.openRuleDoc, ruleId),
              CodeActionKind.QuickFix
            );
          }
        }
      }

      if (result.length > 0) {
        const sameProblems: Map<string, FixableProblem[]> = new Map<
          string,
          FixableProblem[]
        >(allFixableRuleIds.map<[string, FixableProblem[]]>(s => [s, []]));
        const all: FixableProblem[] = [];

        for (const editInfo of fixes.getAllSorted()) {
          if (documentVersion === -1) {
            documentVersion = editInfo.documentVersion;
          }
          if (sameProblems.has(editInfo.ruleId)) {
            const same = sameProblems.get(editInfo.ruleId);
            if (!Fixes.overlaps(getLastEdit(same), editInfo)) {
              same.push(editInfo);
            }
          }
          if (!Fixes.overlaps(getLastEdit(all), editInfo)) {
            all.push(editInfo);
          }
        }
        sameProblems.forEach((same, ruleId) => {
          if (same.length > 1) {
            const sameFixes: WorkspaceChange = new WorkspaceChange();
            const sameTextChange = sameFixes.getTextEditChange({
              uri,
              version: documentVersion
            });
            same
              .map(x => createTextEdit(x))
              .forEach(edit => sameTextChange.add(edit));
            commands.set(CommandIds.applySameFixes, sameFixes);
            const title = `Fix all ${ruleId} problems`;
            const command = Command.create(title, CommandIds.applySameFixes);
            result.get(ruleId).fixAll = CodeAction.create(
              title,
              command,
              CodeActionKind.QuickFix
            );
          }
        });
        if (all.length > 1) {
          const allFixes: WorkspaceChange = new WorkspaceChange();
          const allTextChange = allFixes.getTextEditChange({
            uri,
            version: documentVersion
          });
          all
            .map(x => createTextEdit(x))
            .forEach(edit => allTextChange.add(edit));
          commands.set(CommandIds.applyAllFixes, allFixes);
          const title = `Fix all auto-fixable problems`;
          const command = Command.create(title, CommandIds.applyAllFixes);
          result.fixAll = CodeAction.create(
            title,
            command,
            CodeActionKind.QuickFix
          );
        }
      }
      return result.all();
    });
  },
  (params): number => {
    const document = documents.get(params.textDocument.uri);
    return document ? document.version : undefined;
  }
);

messageQueue.registerRequest(
  ExecuteCommandRequest.type,
  async params => {
    let workspaceChange: WorkspaceChange;
    if (params.command === CommandIds.applyAutoFix) {
      const identifier: VersionedTextDocumentIdentifier = params.arguments[0];
      if (!identifier.uri.startsWith("file:")) {
        return {};
      }
      const textDocument = documents.get(identifier.uri);
      const settings = await Promise.resolve(resolveSettings(textDocument));
      const edits = getAllFixEdits(textDocument, settings);
      if (edits && edits.length) {
        workspaceChange = new WorkspaceChange();
        const textChange = workspaceChange.getTextEditChange(identifier);
        edits.forEach(edit => textChange.add(edit));
      }
    } else if (
      [
        CommandIds.applySingleFix,
        CommandIds.applyDisableLine,
        CommandIds.applyDisableFile
      ].includes(params.command)
    ) {
      const ruleId = params.arguments[0];
      workspaceChange = commands.get(`${params.command}:${ruleId}`);
    } else if (params.command === CommandIds.openRuleDoc) {
      const ruleId = params.arguments[0];
      const url = ruleDocData.urls.get(ruleId);
      if (url) {
        connection.sendRequest(OpenESLintDocRequest.type, { url });
      }
    } else {
      workspaceChange = commands.get(params.command);
    }

    if (!workspaceChange) {
      return {};
    }
    try {
      const response = await Promise.resolve(
        connection.workspace.applyEdit(workspaceChange.edit)
      );
      if (!response.applied) {
        connection.console.error(`Failed to apply command: ${params.command}`);
      }
    } catch (error) {
      connection.console.error(`Failed to apply command: ${params.command}`);
    }
    return {};
  },
  (params): number => {
    if (params.command === CommandIds.applyAutoFix) {
      const identifier: VersionedTextDocumentIdentifier = params.arguments[0];
      return identifier.version;
    }
    return undefined;
  }
);

connection.tracer.connection.listen();
