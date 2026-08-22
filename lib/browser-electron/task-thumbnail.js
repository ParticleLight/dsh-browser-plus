export const TASK_THUMBNAIL_WIDTH = 288;
export const TASK_THUMBNAIL_JPEG_QUALITY = 58;
export const MAX_TASK_THUMBNAIL_BYTES = 180 * 1024;
export function taskThumbnailDataUrl(image) {
    const jpeg = image.resize({ width: TASK_THUMBNAIL_WIDTH }).toJPEG(TASK_THUMBNAIL_JPEG_QUALITY);
    if (jpeg.length === 0 || jpeg.length > MAX_TASK_THUMBNAIL_BYTES)
        return undefined;
    return `data:image/jpeg;base64,${jpeg.toString('base64')}`;
}
