// Type declaration for sql.js — the package ships without @types.
// Only the default export (initSqlJs factory) is declared here; the
// ArtifactDB module maintains its own narrower interface types.
declare module 'sql.js' {
    const initSqlJs: (config?: {
        locateFile?: (file: string) => string;
    }) => Promise<any>;
    export default initSqlJs;
}
