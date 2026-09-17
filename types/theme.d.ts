export interface EditorThemeTokens {
    background: string;
    foreground: string;
    gutter_background: string;
    line_number: string;
    line_number_active: string;
    selection_background: string;
    active_line_background: string;
}
export interface SyntaxThemeTokens {
    comment: string;
    keyword: string;
    string: string;
    number: string;
    constant: string;
    function: string;
    type: string;
    variable: string;
    parameter: string;
    operator: string;
    punctuation: string;
    invalid: string;
}
export interface DiffThemeTokens {
    added: string;
    removed: string;
    modified: string;
    added_background: string;
    removed_background: string;
    added_word_background: string;
    removed_word_background: string;
}
export interface ThemeTokens {
    mode: "light" | "dark";
    "ui-font-size": string;
    background: string;
    main_background: string;
    foreground: string;
    muted: string;
    border: string;
    secondary: string;
    hover: string;
    accent: string;
    danger: string;
    success: string;
    warning: string;
    editor: EditorThemeTokens;
    syntax: SyntaxThemeTokens;
    diff: DiffThemeTokens;
}
export declare const theme: ThemeTokens;
export declare function useTheme(): ThemeTokens;
