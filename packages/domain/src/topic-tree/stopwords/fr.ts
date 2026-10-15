// French function words and generic filler for topic-name terms (hand-written for this
// project; no third-party list is copied).
export const frenchStopwords: readonly string[] =
  `a à au aux avec ce ces cet cette ceci cela celle celles celui ceux chaque chez comme comment dans
de des du donc dont elle elles en encore entre es est et étaient était été être eu eux face fait
faire faut fois il ils je jusqu jusque la là le les leur leurs lors lui ma mais me même mêmes mes
moi moins mon ne ni nos notre nous on ont ou où par parce parmi pas pendant peu peut plus plusieurs
pour pourquoi pourtant puis qu quand que quel quelle quelles quels qui quoi sa sans se selon sera
seront ses si sien sienne son sont sous sur ta te tes toi ton tous tout toute toutes très tu un une
unes uns vers voici voilà vos votre vous y ça avoir ai as avons avez avait avaient aura auront
aurait eût eut eurent étant soit sois sommes êtes serait seraient fut furent suis aussi alors ainsi
après avant bien car cependant certain certaine certaines certains déjà depuis dès dehors dedans
enfin ensuite environ jamais loin lorsque mal malgré mieux notamment parfois partout presque
puisque quelque quelques sinon surtout tant tel telle telles tels toujours trop vraiment deux trois
quatre cinq premier première premiers premières second seconde deuxième troisième grand grande
grands grandes petit petite petits petites partie parties général générale exemple exemples
appelé appelée appelés appelées connu connue connus connues utilisé utilisée utilisés utilisées
utiliser utilise utilisent usage utilisant nouveau nouvelle nouveaux nouvelles différent
différente différents différentes similaire semblable principal principale principaux principales
important importante importants importantes spécifique spécifiques cas type types niveau niveaux
nombre nombres mode manière manières chose choses faits point points côté côtés lieu aujourd hui
hier maintenant devant derrière dessus dessous près pouvoir peuvent doit doivent devoir`.split(
    /\s+/u
  );
