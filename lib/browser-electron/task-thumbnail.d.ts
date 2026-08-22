export declare const TASK_THUMBNAIL_WIDTH = 288;
export declare const TASK_THUMBNAIL_JPEG_QUALITY = 58;
export declare const MAX_TASK_THUMBNAIL_BYTES: number;
export interface ThumbnailImage {
    resize(options: {
        width: number;
    }): {
        toJPEG(quality: number): Buffer;
    };
}
export declare function taskThumbnailDataUrl(image: ThumbnailImage): string | undefined;
