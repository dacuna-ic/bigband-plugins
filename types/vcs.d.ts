export declare const NO_PR_RE: RegExp;
export declare const NO_BRANCH_RE: RegExp;
export declare const NO_GIT_RE: RegExp;
export declare function nearestBookmark(instance: any): Promise<string>;
export declare function prsByBranch(instance: any, { state, limit }?: {
    state?: string;
    limit?: number;
}): Promise<{}>;
export declare function openPr(instance: any, ref: any): Promise<import("./host.ts").ExecResult>;
export declare const PR_DETAIL_FIELDS: string;
export declare function prDetail(instance: any, ref: any): Promise<any>;
export declare function classifyCheck(c: any): "pass" | "fail" | "skip" | "pending";
export declare function summarizeChecks(rollup: any): any;
