// Spanish function words and generic filler for topic-name terms (hand-written for this
// project; no third-party list is copied).
export const spanishStopwords: readonly string[] =
  `a al algo algún alguna algunas alguno algunos allá allí ante antes aquel aquella aquellas aquello
aquellos aquí así aún aunque bajo bien cada casi como con contra cual cuales cuando cuyo cuya cuyos
cuyas de del desde donde dos durante e el él ella ellas ellos en entre era eran es esa esas ese eso
esos esta está están estar estas este esto estos fue fueron ha hace hacen hacer hacia han hasta
hay la las le les lo los más mas me mi mí mis misma mismas mismo mismos mucha muchas mucho muchos
muy nada ni no nos nosotros nuestra nuestras nuestro nuestros nunca o os otra otras otro otros para
pero poco pocos por porque que qué quien quienes se sea sean según ser si sí sido siempre sin sino
sobre solo sólo son su sus también tan tanto te tener tiene tienen toda todas todo todos tras tu
tus un una unas uno unos usted ustedes vez veces y ya yo tres cuatro cinco primero primera segundo
segunda tercero tercera grande grandes mayor mayores menor menores parte partes general ejemplo
ejemplos llamado llamada llamados llamadas conocido conocida conocidos conocidas usado usada usados
usadas usar usa usan uso usando nuevo nueva nuevos nuevas diferente diferentes similar semejante
cierto cierta ciertos ciertas común comunes principal principales importante importantes
específico específica específicos específicas caso casos tipo tipos nivel niveles número números
modo manera maneras cosa cosas hecho hechos punto puntos lado lados lugar hoy ayer ahora después
luego menos tal tales dentro fuera encima debajo junto lejos cerca además había hubo haber tenía
tenían tuve tuvo tengo tenemos será serán sería serían estaba estaban estuvo estoy estamos haciendo
quedar queda quedan puede pueden poder debe deben deber`.split(/\s+/u);
