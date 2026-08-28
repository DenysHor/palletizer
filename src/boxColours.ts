export const boxColours = ['#ee8b3b', '#3f88c5', '#78b159', '#a96cc1', '#d15b72']

export const colourForIndex = (index: number) => boxColours[Math.max(0, index) % boxColours.length]
