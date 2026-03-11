# What is this Project 

I was working along with SQL from many days and I had to handle horrendous amount of SQL statements including usp's, views, scripts etc. When I used to run it in sql server,often times it is really hard to keep up with which columns which tables and which views are being used and how they are being used and what are the join conditions. I used to waste a lot of time to mentally get a picture of how the sql is working, Often times asking AI tools what even is happening. Still the ambiguity used to exist and I had to shoot blind often because AI either overexplains or underexplains.

I searched for sql query visualization tool and found none online which will satisfy my need for a visualization and to figure out.

Then one fine night I decided this matter should be taken in own hands and decided to build a visualizer of my own which can run on a static page such that even if you have slow internet or low internet and if your companies have a strict policies on sharing the data.

# We wont share/save any we just visualize everything runs on client side so data is safe.

# This part for Nerds. What Happens behind the scenes.

This is a purely static website.
We have 
- index.html - for page structure and tabs
- parser.js -  the sql parser
- app.js    -  visualization rendering

There are no frameworks,no libraries,no npm packages used here, All of this runs entirely on the browser.

## How are we processing sql

### Statement splitting :-

On clicking visualize , parseAll() splits SQL into individual statements by scanning for semicolons, It will track the paranthesis depth so that it doesn't split the semicolons inside the subqueries. It does track begin/case/end block so that it doesnt get split inside the stored procedure blocks.


### Statement Classification :-

Each statement will be classified on the basis of the keywords such as select,insert,update,delete etc(Most of the sql statements we are supporting if anything is missed please suggest). And each of this type will be routed to its own parser.


### Select Parsing :-

In the select statement we parse CTEs, We detect set operations, We extract the column list, We extract from clause, We take care of joins, We extract group by, having ,order by, subqueries recursively.


### How the diagram is working :-
The diagram is drawn using browser native SVG.

We are using BFS tree algorithm such that 
- first table in from clause is placed at center left
- each join will add the new table one level to right
- tables with same depth are stacked vertically.



Table node will be showing the table name as header and will list all the columns that are selected from the table.

Edges or the join lines connect tables using orthogonal lines and each edge will get a unique color from the pallete I have decided (Yes me!).
A pill will show the join type.


### We have following tabs so that you can understand your query better.

Join Diagram	- The SVG visual of tables and their relationships

Tables          - Cards for each table with its columns listed

Columns         - Every selected column with its source,CASE/window         function badges

Conditions      - WHERE, GROUP BY, HAVING, ORDER BY — with subquery details expanded inline

CTEs            - Common Table Expressions defined in the WITH clause

Statements      - Every statement in the input, typed and color-coded — INSERT cards show the target table, CREATE TABLE shows columns and constraints, ALTER shows what operation was performed, IF/WHILE shows the condition and inner statements, etc.


If you want to run this in your local just clone this and open index.html thats it. 


Otherwise if you want to use through browser you can access through this link :-
https://sudharshanhegde.github.io/SQL-query-Visualizer/


Any changes or updates on the functionality or the issues are welcome, If you want to suggest a new feature, That is also welcome.


Thanks for reading.

