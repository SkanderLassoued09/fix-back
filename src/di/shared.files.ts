import { withErrorContext } from '../common/error-context';
export function getFileExtension(base64) {
  try {
    const metaData = base64.split(',')[0];
    const fileType = metaData.split(':')[1].split(';')[0];
    const extension = fileType.split('/')[1];
    return extension;
  } catch (error) {
    throw withErrorContext(error, 'getFileExtension');
  }
}
