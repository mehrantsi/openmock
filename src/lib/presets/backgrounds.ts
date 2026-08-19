/** Image background catalog. All free in OpenMock. */

export interface ImageBackground {
  id: string
  name: string
  url: string
  preview: string
}

const bg = (id: string, name: string, file: string): ImageBackground => ({
  id,
  name,
  url: `/backgrounds/${file}`,
  preview: `url("/backgrounds/${file}") center / cover no-repeat`,
})
const thumbBg = (id: string, name: string, file: string): ImageBackground => ({
  id,
  name,
  url: `/backgrounds/thumbs/${file}`,
  preview: `url("/backgrounds/thumbs/${file}") center / cover no-repeat`,
})

export const IMAGE_BACKGROUNDS: ImageBackground[] = [
  bg('glaze', 'Glaze', 'glaze.jpeg'),
  bg('crystal', 'Crystal', 'crystal.jpeg'),
  bg('liquid-metal', 'Liquid Metal', 'liquid_metal.jpeg'),
  bg('clouds', 'Clouds', 'sky.jpeg'),
  bg('spectrum', 'Spectrum', 'spectrum.jpeg'),
  bg('sunrise', 'Sunrise', 'sunrise.jpeg'),
  bg('whisp', 'Whisp', 'whisp.jpeg'),
  bg('bubble', 'Bubble', 'bubble.jpeg'),
  thumbBg('heather', 'Heather', 'heather.jpg'),
  thumbBg('palm-shadow', 'Palm Shadow', 'palm-shadow.jpg'),
  thumbBg('prism', 'Prism', 'prism.jpg'),
  thumbBg('sky', 'Sky', 'sky.jpg'),
  thumbBg('sundrape', 'Sundrape', 'sundrape.jpg'),
]

export const DEFAULT_BG_IMAGE = IMAGE_BACKGROUNDS[0].url
