/**
 * The code in this file has been adapted from the Obsidian Kanban Tables plugin which can be found here: 
 * https://github.com/mgmeyers/obsidian-kanban/blob/8501981a1afacb4c8fc03ec60604aa5eedfbd857/src/components/Editor/MarkdownEditor.tsx
 */

import { App, Component, Editor, TFile } from "obsidian";
import { Extension } from "@codemirror/state"
import { ViewUpdate } from "@codemirror/view"

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

export interface MarkdownController {
    set editMode(mode: AdaptedEditor | null);
}

export interface EditorConstructor {
    new(app: App, element: Element, controller: MarkdownController): AdaptedEditor
}

export interface AdaptedEditor extends Component {
    setChangeHandler(changeHandler: (update: ViewUpdate) => undefined | undefined): undefined;
    setContent(content: string): undefined;
}

function getTableCellEditorClass(superclass: { new(app: App, element: Element, controller: MarkdownController): any }): EditorConstructor {
    class TableCellEditor extends superclass implements AdaptedEditor {
        onChange: (update: ViewUpdate) => undefined | undefined

        constructor(app: App, element: Element, controller: MarkdownController) {
            super(app, element, controller);
        }

        isCellEditor = true;
        updateBottomPadding() { }
        onUpdate(update: ViewUpdate, changed: boolean) {
            super.onUpdate(update, changed);
            this.onChange && this.onChange(update);
        }
        buildLocalExtensions(): Extension[] {
            const extensions = super.buildLocalExtensions();
            // TODO: Hook into events here like Kanban does, to handle paste and so on.
            return extensions;
        }

        setChangeHandler(changeHandler: (update: ViewUpdate) => undefined | undefined): undefined {
            this.onChange = changeHandler;
        }

        setContent(content: string): undefined {
            this.set(content);
        }
    }

    return TableCellEditor;
}

function noop() { }

function getMarkdownController(obsidianApp: App, file: TFile, getEditor: () => Editor): MarkdownController {
    return {
        app: obsidianApp,
        showSearch: noop,
        toggleMode: noop,
        onMarkdownScroll: noop,
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
    }
}

export {
    getMarkdownEditorClass,
    getTableCellEditorClass,
    getMarkdownController,
    AdaptedEditor,
    MarkdownController,
}

