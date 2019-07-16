import {
  ConfigurationChangeEvent,
  ExtensionContext,
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  ServiceStat,
  TransportKind,
  Uri,
  WorkspaceMiddleware,
  commands,
  services,
  workspace
} from "coc.nvim";
import { ProviderResult } from "coc.nvim/lib/provider";
import fs from "fs";
import path from "path";
import {
  CodeAction,
  CodeActionContext,
  Command,
  Diagnostic,
  DidCloseTextDocumentNotification,
  DidOpenTextDocumentNotification,
  DocumentSelector,
  ExecuteCommandParams,
  ExecuteCommandRequest,
  NotificationType,
  RequestType,
  TextDocument,
  TextDocumentIdentifier,
  VersionedTextDocumentIdentifier,
  WorkspaceFolder
} from "vscode-languageserver-protocol";
import { findEslint } from "./utils";

const defaultLanguages = ["javascript", "javascriptreact"];
namespace Is {
  const toString = Object.prototype.toString;

  export function boolean(value: any): value is boolean {
    return value === true || value === false;
  }

  export function string(value: any): value is string {
    return toString.call(value) === "[object String]";
  }
}

interface DirectoryItem {
  directory: string;
  changeProcessCWD?: boolean;
}

interface OpenESLintDocParams {
  url: string;
}

interface OpenESLintDocResult {}

namespace OpenESLintDocRequest {
  export const type = new RequestType<
    OpenESLintDocParams,
    OpenESLintDocResult,
    void,
    void
  >("eslint/openDoc");
}

interface CodeActionSettings {
  disableRuleComment: {
    enable: boolean;
    location: "separateLine" | "sameLine";
  };
  showDocumentation: {
    enable: boolean;
  };
}

namespace DirectoryItem {
  export function is(item: any): item is DirectoryItem {
    const candidate = item as DirectoryItem;
    return (
      candidate &&
      Is.string(candidate.directory) &&
      (Is.boolean(candidate.changeProcessCWD) ||
        candidate.changeProcessCWD === void 0)
    );
  }
}

type RunValues = "onType" | "onSave";

interface TextDocumentSettings {
  validate: boolean;
  packageManager: "npm" | "yarn";
  autoFix: boolean;
  autoFixOnSave: boolean;
  quiet: boolean;
  options: any | undefined;
  nodePath: string | undefined;
  run: RunValues;
  workspaceFolder: WorkspaceFolder | undefined;
  workingDirectory: DirectoryItem | undefined;
  codeAction: CodeActionSettings;
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

const exitCalled = new NotificationType<[number, string], void>(
  "eslint/exitCalled"
);

async function createDefaultConfiguration(): Promise<void> {
  const { root } = workspace;
  const configFiles = [
    ".eslintrc.js",
    ".eslintrc.yaml",
    ".eslintrc.yml",
    ".eslintrc",
    ".eslintrc.json"
  ];
  for (const configFile of configFiles) {
    if (fs.existsSync(path.join(root, configFile))) {
      workspace.openResource(Uri.file(root).toString()).catch(error => {
        // noop
      });
      return;
    }
  }
  const eslintCommand = await findEslint(root);
  await workspace.nvim.call("coc#util#open_terminal", [
    {
      cmd: `${eslintCommand} --init`,
      cwd: root
    }
  ]);
}

function shouldBeValidated(textDocument: TextDocument): boolean {
  const config = workspace.getConfiguration("eslint", textDocument.uri);
  if (!config.get("enable", true)) return false;
  const filetypes = config.get<(string)[]>("filetypes", defaultLanguages);
  return filetypes.includes(textDocument.languageId);
}

export async function activate(context: ExtensionContext): Promise<void> {
  const { subscriptions } = context;
  const config = workspace.getConfiguration().get<any>("eslint", {});
  const filetypes = config.filetypes || ["javascript", "javascriptreact"];
  const selector: DocumentSelector = filetypes.reduce((res, filetype) => {
    return res.concat([
      { language: filetype, scheme: "file" },
      { language: filetype, scheme: "untitled" }
    ]);
  }, []);

  const serverOptions: ServerOptions = {
    module: context.asAbsolutePath("./lib/server/index.js"),
    args: ["--node-ipc"],
    transport: TransportKind.ipc,
    options: {
      cwd: workspace.root,
      execArgv: config.execArgv
    }
  };

  const syncedDocuments: Map<string, TextDocument> = new Map();

  const clientOptions: LanguageClientOptions = {
    documentSelector: selector,
    synchronize: {
      configurationSection: "eslint",
      fileEvents: [
        workspace.createFileSystemWatcher(
          "**/.eslintr{c.js,c.yaml,c.yml,c,c.json}"
        ),
        workspace.createFileSystemWatcher("**/.eslintignore"),
        workspace.createFileSystemWatcher("**/package.json")
      ]
    },
    outputChannelName: "eslint",
    initializationOptions: config.initializationOptions,
    diagnosticCollectionName: "eslint",
    initializationFailedHandler: error => {
      workspace.showMessage(
        `Eslint server initialization failed: ${error.message}.`,
        "error"
      );
      return false;
    },
    middleware: {
      didOpen: (document, next) => {
        if (shouldBeValidated(document)) {
          next(document);
          syncedDocuments.set(document.uri.toString(), document);
        }
      },
      didChange: (event, next) => {
        if (syncedDocuments.has(event.textDocument.uri)) {
          next(event);
        }
      },
      didClose: (document, next) => {
        const uri = document.uri.toString();
        if (syncedDocuments.has(uri)) {
          syncedDocuments.delete(uri);
          next(document);
        }
      },
      provideCodeActions: (
        document,
        range,
        context,
        token,
        next
      ): ProviderResult<(Command | CodeAction)[]> => {
        if (
          !syncedDocuments.has(document.uri.toString()) ||
          !context.diagnostics ||
          context.diagnostics.length === 0
        ) {
          return [];
        }
        const eslintDiagnostics: Diagnostic[] = [];
        for (const diagnostic of context.diagnostics) {
          if (diagnostic.source === "eslint") {
            eslintDiagnostics.push(diagnostic);
          }
        }
        if (eslintDiagnostics.length === 0) {
          return [];
        }
        const newContext: CodeActionContext = {
          ...context,
          ...({
            diagnostics: eslintDiagnostics
          } as CodeActionContext)
        };
        return next(document, range, newContext, token);
      },
      workspace: {
        configuration: (params, _token, _next): any => {
          return params.items.map(item => {
            const uri = item.scopeUri;
            const config = workspace.getConfiguration("eslint", uri);
            const pm = config.get("packageManager", "npm");
            return {
              packageManager: pm || "npm",
              quiet: config.get("quiet", false),
              validate: config.get("validate", true),
              autoFix: config.get("autoFix", false),
              autoFixOnSave: config.get("autoFixOnSave", false),
              nodePath: config.get("nodePath", undefined),
              options: config.get<Object>("options", {}),
              run: config.get("run", "onType"),
              workspaceFolder: workspace.workspaceFolder,
              workingDirectory: undefined,
              codeAction: {
                disableRuleComment: config.get(
                  "codeAction.disableRuleComment",
                  { enable: true, location: "separateLine" as "separateLine" }
                ),
                showDocumentation: config.get("codeAction.showDocumentation", {
                  enable: true
                })
              }
            };
          });
        }
      } as WorkspaceMiddleware
    }
  };

  const client = new LanguageClient(
    "eslint",
    "eslint langserver",
    serverOptions,
    clientOptions
  );

  subscriptions.push(services.registLanguageClient(client));

  function onDidChangeConfiguration(e: ConfigurationChangeEvent): void {
    if (!e.affectsConfiguration("eslint")) return;
    if (client.serviceState != ServiceStat.Running) return;
    for (const textDocument of syncedDocuments.values()) {
      if (!shouldBeValidated(textDocument)) {
        syncedDocuments.delete(textDocument.uri);
        client.sendNotification(DidCloseTextDocumentNotification.type, {
          textDocument: { uri: textDocument.uri }
        });
      }
    }
    for (const textDocument of workspace.textDocuments) {
      if (
        !syncedDocuments.has(textDocument.uri.toString()) &&
        shouldBeValidated(textDocument)
      ) {
        client.sendNotification(DidOpenTextDocumentNotification.type, {
          textDocument: {
            uri: textDocument.uri,
            languageId: textDocument.languageId,
            version: textDocument.version,
            text: textDocument.getText()
          }
        });
        syncedDocuments.set(textDocument.uri.toString(), textDocument);
      }
    }
  }

  subscriptions.push(
    commands.registerCommand("eslint.createConfig", createDefaultConfiguration)
  );

  subscriptions.push(
    commands.registerCommand("eslint.executeAutofix", async () => {
      const document = await workspace.document;
      const textDocument: VersionedTextDocumentIdentifier = {
        uri: document.uri,
        version: document.version
      };
      const params: ExecuteCommandParams = {
        command: "eslint.applyAutoFix",
        arguments: [textDocument]
      };
      client
        .sendRequest(ExecuteCommandRequest.type, params)
        .then(undefined, () => {
          workspace.showMessage(
            "Failed to apply ESLint fixes to the document.",
            "error"
          );
        });
    })
  );

  client.onReady().then(
    () => {
      client.onNotification(exitCalled, params => {
        workspace.showMessage(
          `Server process exited with code ${params[0]}. This usually indicates a misconfigured ESLint setup.`,
          "error"
        );
      });
      client.onRequest(NoConfigRequest.type, params => {
        const document = Uri.parse(params.document.uri);
        const fileLocation = document.fsPath;
        workspace.showMessage(
          `No ESLint configuration (e.g .eslintrc) found for file: ${fileLocation}`,
          "warning"
        );
        return {};
      });
      client.onRequest(NoESLintLibraryRequest.type, params => {
        const uri: Uri = Uri.parse(params.source.uri);
        workspace.showMessage(
          `Failed to load the ESLint library for the document ${uri.fsPath}`,
          "warning"
        );
        return {};
      });
      client.onRequest(OpenESLintDocRequest.type, async params => {
        await commands.executeCommand("vscode.open", Uri.parse(params.url));
        return {};
      });

      workspace.onDidChangeConfiguration(
        onDidChangeConfiguration,
        null,
        subscriptions
      );
    },
    _e => {
      // noop
    }
  );
}
