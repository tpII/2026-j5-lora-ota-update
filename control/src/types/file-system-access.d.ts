/**
 * The directory picker of the File System Access API (https://wicg.github.io/file-system-access/).
 * The DOM library of TypeScript declares the handles but not the picker.
 */

interface DirectoryPickerOptions {
  id?: string;
  mode?: "read" | "readwrite";
  startIn?: FileSystemHandle | "desktop" | "documents" | "downloads";
}

interface Window {
  /** Present only in browsers that implement the File System Access API. */
  showDirectoryPicker?: (options?: DirectoryPickerOptions) => Promise<FileSystemDirectoryHandle>;
}
