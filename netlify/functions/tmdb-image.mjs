import fetch from 'node-fetch'
import getImageTypeFromBuffer from 'image-type'
import sharp from 'sharp'
import etag from 'etag'
import isSvg from 'is-svg'

// Sizes at https://api.themoviedb.org/3/configuration
const base_url = 'https://image.tmdb.org/t/p/original'

// 6MB is hard max Lambda response size
const MAX_RESPONSE_SIZE = 6291456


const IGNORED_FORMATS = new Set([
    'svg',
    'gif'
])
const OUTPUT_FORMATS = new Set([
    'png',
    'jpg',
    'webp',
    'avif'
])

function getImageType(buffer) {
    const type = getImageTypeFromBuffer(buffer)
    if (type) {
        return type
    }
    if (isSvg(buffer)) {
        return { ext: 'svg', mime: 'image/svg' }
    }
    return null
}

function getOptions( eventUrlString ) {

    const eventUrl = new URL( eventUrlString, process.env.URL )

    console.log('eventUrl', eventUrl) // eslint-disable-line no-console

    const {
        w = 750,
        q = 95,
        // format = null,
    } = Object.fromEntries( eventUrl.searchParams )

    const width = parseInt(w)

    if (!width) {
        throw new Error('Width is not a number')
    }

    const quality = parseInt(q) || 60


    // marvelorderstaging.wpengine.com/2021/11/Chamber-1-V2.jpg
    const imagePath = eventUrl.pathname.split('tmdb-image/')[1]

    const contentUrl = `${ base_url }/${ imagePath }`

    // Just always assume it's a jpg source
    const requestExtension = 'jpg'//imagePath.split(/[#?]/)[0].split('.').pop().trim()


    return {
        width,
        quality,
        contentUrl,
        requestExtension
        // format,
    }
}



// Example URL
// https://marvelorder-full-static.netlify.app/.netlify/functions/wp-image/marvelorderstaging.wpengine.com/2021/11/Chamber-1-V2.jpg?w=800&q=80&format
export async function handler( event ) {

    // console.log('event', event)

    let options = {}

    // Parse and validate options
    try {
        options = getOptions( event.path )

    } catch (error) {
        console.error( 'Invalid image options', error ) // eslint-disable-line no-console

        return {
            statusCode: 400,
            body: 'Invalid image options',
        }
    }


    const {
        width,
        quality,
        contentUrl,
        requestExtension
    } = options

    let sourceImage

    // Move Request Extension to the start of the list
    // so that it is the first to be tried
    const imageTypes = new Set([
        requestExtension,
        ...OUTPUT_FORMATS
    ])


    // Run through image types until we find one that works
    for (const imageType of imageTypes) {
        const typeUrl = contentUrl.replace( `.${requestExtension}`, `.${imageType}` )

        // Fetch our WordPress image
        sourceImage = await fetch( typeUrl )

        // If we got a 200, we're good
        if (sourceImage.status === 200) {
            break
        }

        // Otherwise, try the next type
    }

    // If we don't have an image, we're done
    if (!sourceImage.ok) {
        console.error(`Failed to download image ${contentUrl}. Status ${sourceImage.status} ${sourceImage.statusText}`)
        return {
            statusCode: sourceImage.status,
            body: sourceImage.statusText,
        }
    }

    // console.log('imageTypes', imageTypes) // eslint-disable-line no-console


    const sourceBufferData = await sourceImage.buffer()

    const sourceType = getImageType(sourceBufferData)

    if (!sourceType) {
        return { statusCode: 400, body: 'Source does not appear to be an image' }
    }

    let { ext } = sourceType

    // For unsupported formats (gif, svg) we redirect to the original
    if (IGNORED_FORMATS.has(ext)) {
        return {
            statusCode: 302,
            headers: {
                Location: contentUrl,
            },
        }
    }

    // Set contrast and brightness for mask - https://github.com/lovell/sharp/issues/1958#issuecomment-552115591
    const contrast = 1.1;
    const brightness = 6.5;

    // Use an RGB channel buffer to create a easy Mask
    // https://github.com/lovell/sharp/issues/1113#issuecomment-363187713
    const maskBuffer = await sharp(sourceBufferData)
        .rotate()
        // .greyscale()
        .extractChannel('red') // also B or G would work
        .resize(width, null, { withoutEnlargement: true })
        .linear(contrast, -(128 * contrast) + 128)
        .modulate({ brightness: brightness })
        .toBuffer()


    // The format methods are just to set options: they don't
    // make it return that format.
    const { info, data: outputBuffer } = await sharp(sourceBufferData)
        .rotate()
        .ensureAlpha()
        .joinChannel( maskBuffer )
        // .jpeg({ quality, force: requestExtension === 'jpg' })
        .png({ quality, force: true })
        // .webp({ quality, force: requestExtension === 'webp' })
        // .avif({ quality, force: requestExtension === 'avif' })
        .resize(width, null, { withoutEnlargement: true })
        // Trims of any transparent pixels - https://github.com/lovell/sharp/issues/1246#issuecomment-393854745
        // .trim()
        .toBuffer({ resolveWithObject: true })

    if (outputBuffer.length > MAX_RESPONSE_SIZE) {
        return {
            statusCode: 400,
            body: 'Requested image is too large. Maximum size is 6MB.',
        }
    }



    return {
        statusCode: 200,
        headers: {
            'Content-Type': `image/${info.format}`,
            'Cache-Control': 'public, max-age=365000000, immutable',
            etag: etag(outputBuffer),
        },
        body: outputBuffer.toString('base64'),
        isBase64Encoded: true,
    }

}


export default handler