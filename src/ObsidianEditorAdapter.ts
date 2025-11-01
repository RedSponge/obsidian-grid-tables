import { App, TFile, Plugin } from "obsidian";
import { AdaptedEditor, EditorConstructor, getMarkdownController, getMarkdownEditorClass, getTableCellEditorClass, MarkdownController, TableChangeHandler } from "./ObsidianEditorMagic";
import { EditorView, ViewUpdate } from "@codemirror/view"
import { Extension } from "@codemirror/state"

class ObsidianEditorAdapter {
    plugin: Plugin;

    editorClass: EditorConstructor;

    activeController: MarkdownController | null;
    activeEditor: AdaptedEditor | null;

    extraExtensionProvider: () => Extension[];

    constructor(plugin: Plugin) {
        this.plugin = plugin;

        const MarkdownEditor = getMarkdownEditorClass(this.obsidianApp);
        this.editorClass = getTableCellEditorClass(MarkdownEditor);

        this.activeController = null;
        this.activeEditor = null;

        this.extraExtensionProvider = () => [];
    }

    get obsidianApp(): App {
        return this.plugin.app;
    }

    get editorView(): EditorView {
        if (!this.activeEditor) {
            throw new Error("Not mounted!");
        }
        return this.activeEditor?.cm;
    }

    setExtraExtensionProvider(provider: () => Extension[]) {
        if (this.activeEditor) {
            console.warn("Changing the ExtensionProvider will not affect a mounted editor!");
        }

        this.extraExtensionProvider = provider;
    }


    mount(element: Element, file: TFile) {
        if (this.activeController || this.activeEditor) {
            throw new Error("Already mounted!");
        }

        const controller = getMarkdownController(this.obsidianApp, file, () => editor.editor);
        const editor = new this.editorClass(this.obsidianApp, element, controller);

        editor.setExtraExtensionProvider(this.extraExtensionProvider);

        this.activeController = controller;
        this.activeEditor = editor;

        this.plugin.addChild(this.activeEditor);
        this.activeController.editMode = editor;
    }

    unmount() {
        if (!this.activeEditor) {
            return;
        }

        this.plugin.removeChild(this.activeEditor);
        this.activeEditor = null;
        this.activeController = null;
    }

    setContent(content: string) {
        if (!this.activeEditor) {
            throw new Error("Not mounted!");
        }

        this.activeEditor.setContent(content);
    }

    getContent(): string {
        if (!this.activeEditor) {
            throw new Error("Not mounted!");
        }

        return this.activeEditor.getContent();
    }

    setChangeHandler(onChange: TableChangeHandler | undefined) {
        if (!this.activeEditor) {
            throw new Error("Not mounted!");
        }
        this.activeEditor.setChangeHandler(onChange);
    }

    getChangeHandler(): TableChangeHandler | undefined {
        if (!this.activeEditor) {
            throw new Error("Not mounted!");
        }
        return this.activeEditor.getChangeHandler();
    }

    focus() {
        if (!this.activeEditor) {
            throw new Error("Not mounted!");
        }

        this.activeEditor.focus();
    }
}

export {
    ObsidianEditorAdapter,
}