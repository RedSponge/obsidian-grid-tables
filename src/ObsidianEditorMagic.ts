/**
 * The code in this file has been adapted from the Obsidian Kanban Tables plugin which can be found here: 
 * https://github.com/mgmeyers/obsidian-kanban/blob/8501981a1afacb4c8fc03ec60604aa5eedfbd857/src/components/Editor/MarkdownEditor.tsx
 */

import { App, Component, Editor, TFile } from "obsidian";
import { Extension } from "@codemirror/state"
import { EditorView, ViewUpdate } from "@codemirror/view"

function getMarkdownEditorClass(app: App) {
    // @ts-ignore: Accessing hidden parameters.
    const md = app.embedRegistry.embedByExtension.md(
        { app: app, containerEl: createDiv(), state: {} },
        null,
        ''
    );

    md.load();
    md.editable = true;
    md.showEditor();

    const MarkdownEditor = Object.getPrototypeOf(Object.getPrototypeOf(md.editMode)).constructor;

    md.unload();

    return MarkdownEditor;
}

export type MarkdownController = {
    set editMode(mode: AdaptedEditor | null)
    app: App
    showSearch: () => void
    toggleMode: () => void
    onMarkdownScroll: () => void
    syncScroll: () => void
    getMode: () => string
    scroll: number
    editMode: AdaptedEditor | null
    get editor(): Editor
    get file(): TFile
    get path(): string
    nestedMdController: boolean | undefined
}

export interface EditorConstructor {
    new(app: App, element: Element, controller: MarkdownController): AdaptedEditor
}

export type TableChangeHandler = (update: ViewUpdate) => void;

export interface AdaptedEditor extends Component {
    setChangeHandler(changeHandler: TableChangeHandler | undefined): void;
    getChangeHandler(): TableChangeHandler | undefined;
    setContent(content: string): void;
    getContent(): string;
    setExtraExtensionProvider(provider: () => any[]): void;
    focus(): void
    syncScroll(): void

    // Inferred using a debugger
    get app(): App;
    get cm(): EditorView;
    get containerEl(): HTMLElement;
    get editor(): Editor;
    get parentEditor(): EditorView | null
    set parentEditor(editor: EditorView | null);

}


function getTableCellEditorClass(superclass: { new(app: App, element: Element, controller: MarkdownController): any }): EditorConstructor {
    // @ts-expect-error
    class TableCellEditor extends superclass implements AdaptedEditor {
        onChange: TableChangeHandler | undefined;
        extraExtensionProvider: (() => Extension[]) | undefined;
        parentEditor: EditorView | null

        constructor(app: App, element: Element, controller: MarkdownController) {
            super(app, element, controller);
            this.extraExtensionProvider = undefined;
            this.parentEditor = null;
        }

        setExtraExtensionProvider(provider: (() => Extension[]) | undefined): void {
            this.extraExtensionProvider = provider;
        }

        isCellEditor = true;
        updateBottomPadding() { }
        onUpdate(update: ViewUpdate, changed: boolean) {
            super.onUpdate(update, changed);
            this.onChange && this.onChange(update);
        }
        buildLocalExtensions(): Extension[] {
            const extensions: Extension[] = super.buildLocalExtensions();
            if (this.extraExtensionProvider) {
                const extraExtensions = this.extraExtensionProvider();
                extensions.push(...extraExtensions);
            }
            return extensions;
        }

        setChangeHandler(changeHandler: TableChangeHandler | undefined): void {
            this.onChange = changeHandler;
        }

        getChangeHandler(): TableChangeHandler | undefined {
            return this.onChange;
        }

        setContent(content: string): void {
            this.set(content);
        }
        getContent(): string {
            return this.get()
        }
    }

    // @ts-expect-error
    return TableCellEditor;
}

function noop() { }

function getMarkdownController(obsidianApp: App, file: TFile, getEditor: () => Editor): MarkdownController {
    return {
        app: obsidianApp,
        showSearch: noop,
        toggleMode: noop,
        onMarkdownScroll: noop,
        syncScroll: noop,
        getMode: () => 'source',
        scroll: 0,
        editMode: null,
        get editor() {
            return getEditor();
        },
        get file() {
            return file;
        },
        get path() {
            return file.path;
        },
        nestedMdController: true,
    }
}

export {
    getMarkdownEditorClass,
    getTableCellEditorClass,
    getMarkdownController,
}

