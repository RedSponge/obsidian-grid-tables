import { App, TFile, Plugin } from "obsidian";
import { AdaptedEditor, EditorConstructor, getMarkdownController, getMarkdownEditorClass, getTableCellEditorClass, MarkdownController } from "./ObsidianEditorMagic";
import { ViewUpdate } from "@codemirror/view"

class ObsidianEditorAdapter {
    obsidianApp: App;
    plugin: Plugin;

    editorClass: EditorConstructor;

    activeController: MarkdownController | null;
    activeEditor: AdaptedEditor | null;

    constructor(obsidianApp: App, plugin: Plugin) {
        this.obsidianApp = obsidianApp;
        this.plugin = plugin;

        const MarkdownEditor = getMarkdownEditorClass(this.obsidianApp);
        this.editorClass = getTableCellEditorClass(MarkdownEditor);

        this.activeController = null;
        this.activeEditor = null;
    }

    mount(element: Element, file: TFile) {
        if (this.activeController || this.activeEditor) {
            throw new Error("Already mounted!");
        }

        const controller = getMarkdownController(this.obsidianApp, file, () => editor.editor);
        const editor = new this.editorClass(this.obsidianApp, element, controller);

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

    setChangeHandler(onChange: (update: ViewUpdate) => undefined | undefined) {
        if (!this.activeEditor) {
            throw new Error("Not mounted!");
        }
        this.activeEditor.setChangeHandler(onChange);
    }
}

export {
    ObsidianEditorAdapter,
}