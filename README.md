# Undercall - Render Ready

Node/Express + WebSocket multiplayer social-deception phone game, playable with 2-5 players.

## Wat is er aangepast t.o.v. de vorige versie

**Bugfixes (het spel crashte/hing vast op deze punten):**
- Spelstart crashte met `i is not defined` bij het uitdelen van het startcijfer.
- Nieuwe spelers werden niet zichtbaar voor de rest van de lobby (roomState werd niet gebroadcast).
- Een inkomend gesprek weigeren (ophangen vóór opnemen) meldde dit nooit aan de beller — de telefoonlijn bleef daardoor voor de hele room "bezet" tot een herstart.
- De "Wederzijdse Bekentenis"-challenge (type 3) werd nooit aan de tweede speler getoond, waardoor die challenge onmogelijk te voltooien was.
- De "Getuigenis-Verificatie"-challenge (type 0) kon nooit slagen: de client stuurde het vereiste veld niet mee.
- Na een geslaagde "Wederzijdse Bekentenis" werd er geen nieuwe challenge meer ingepland — de room stopte daarna met challenges genereren.
- De "Saboteur's Sabotage"-opdracht kon aan gewone operators worden toegewezen, die hem nooit konden voltooien.

**De domme rekensommen zijn vervangen door:**
- **Code-Kraak**: een Caesar-cijfer om te ontcijferen (bv. een verschoven woord als `GHVLQP`) in plaats van een keersom.
- **Geheugentest** (nieuw!): een Simon-says-achtig lichtpatroon dat je moet onthouden en naklikken.
- **Afstand-Afluistering**: nu "twee waarheden, één leugen" over de spelregels, in plaats van een rekensom.

**Nieuwe, leukere dingen:**
- **CASE LOG**: een blijvend logboek in de zijbalk van alle meldingen, zodat je niets mist dat maar even als toast verscheen.
- **Stem op de Saboteur**: als de klok afloopt start automatisch een stemronde — iedereen wijst de vermeende saboteur aan, en na de stemming wordt onthuld wie het echt was. Daarna keert iedereen terug naar de lobby voor een nieuwe ronde.

## Render
- Environment: Node
- Root Directory: leave empty
- Build Command: npm install
- Start Command: npm start
