const express = require('express')
const cors = require('cors')
const Stripe = require("stripe");
const jwt = require('jsonwebtoken')
const cookieParser = require('cookie-parser')
require('dotenv').config()

// stripe
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// firebase admin
const admin = require("firebase-admin");
let serviceAccount;

try {
    const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString('utf-8')
    serviceAccount = JSON.parse(decodedKey)
} catch (error) {
    console.error("Error parsing Firebase service key:", error.message)

    if (process.env.FB_SERVICE_KEY) {
        try {
            serviceAccount = JSON.parse(process.env.FB_SERVICE_KEY)
        } catch (e) {
            console.error("FB_SERVICE_KEY is not valid JSON either")
        }
    }
}

if (serviceAccount) {
    try {
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("Firebase Admin initialized successfully")
    } catch (error) {
        console.error("Firebase Admin initialization failed:", error.message)
    }
} else {
    console.warn("Firebase Admin not initialized - service account not available")
}

const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')

const app = express()
const port = process.env.PORT || 3000

// middleware
app.use(cors({
    origin: ['http://localhost:5173'],
    credentials: true
}))
app.use(express.json())
app.use(cookieParser())

//DB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@jubaid.xspkh92.mongodb.net/?retryWrites=true&w=majority`

const client = new MongoClient(uri, {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
});

async function run() {
    try {
        // await client.connect();
        // console.log("MongoDB Connected Successfully!");

        const database = client.db('coffee-web')
        const coffeesCollection = database.collection('coffees')
        const ordersCollection = database.collection('orders')
        const cartCollection = database.collection('cart')
        const paymentCollection = database.collection('payment')


        // Middleware to verify Firebase Token
        const verifyFirebaseToken = async (req, res, next) => {
            const authHeader = req.headers.authorization

            if (!authHeader) {
                return res.status(401).send({ message: 'No token' })
            }
            const token = authHeader.split(' ')[1]

            try {
                const decoded = await admin.auth().verifyIdToken(token)
                req.user = decoded
                next()
            } catch (err) {
                return res.status(403).send({ message: 'Invalid Firebase token' })
            }
        }

        // Middleware to verify JWT
        const verifyToken = (req, res, next) => {
            const token = req.cookies?.token

            if (!token) {
                return res.status(401).send({ message: 'Unauthorized: No token provided' })
            }
            jwt.verify(token, process.env.JWT_SECRET_KEY, (err, decoded) => {
                if (err) {
                    return res.status(403).send({ message: 'Forbidden: Invalid token' })
                }
                req.user = decoded
                next()
            })
        }

        //generate jwt
        app.post('/jwt', async (req, res) => {
            const user = { email: req.body.email }

            // token create
            const token = jwt.sign(user, process.env.JWT_SECRET_KEY, {
                expiresIn: '7d'
            })
            res.cookie('token', token, {
                httpOnly: true,
                secure: false,
                sameSite: "lax"
            }).send({ success: true })
        })


        app.get('/coffees', async (req, res) => {
            const allCoffees = await coffeesCollection.find().toArray()
            res.send(allCoffees)
        })

        //save in database 
        app.post('/addCoffee', verifyToken, async (req, res) => {
            const coffeeData = req.body
            coffeeData.quantity = Number(coffeeData.quantity)
            const result = await coffeesCollection.insertOne(coffeeData)
            console.log(coffeeData);
            res.send({ ...result, message: "got it" })
        })

        //update coffee
        app.patch("/coffee/:id", verifyToken, async (req, res) => {
            const id = req.params.id
            const updatedCoffee = req.body

            // Ensure quantity is numeric if present
            if (updatedCoffee.quantity !== undefined) {
                updatedCoffee.quantity = Number(updatedCoffee.quantity)
            }

            const result = await coffeesCollection.updateOne(
                { _id: new ObjectId(id) },
                { $set: updatedCoffee }
            )

            res.send(result)
        })


        //get single coffee by id
        app.get('/coffee/:id', async (req, res) => {
            const id = req.params.id
            const filter = { _id: new ObjectId(id) }
            const coffee = await coffeesCollection.findOne(filter)
            console.log(id);
            res.send(coffee)
        })

        //  mycoffees 
        app.get('/myCoffees/:email', async (req, res) => {
            const email = req.params.email
            const filter = { email }
            const myCoffees = await coffeesCollection.find(filter).toArray()
            console.log(email);
            res.send(myCoffees)
        })


        // handle like toggle
        app.patch('/like/:coffeeId', async (req, res) => {
            const id = req.params.coffeeId
            const email = req.body.email
            const filter = { _id: new ObjectId(id) }
            const coffee = await coffeesCollection.findOne(filter)

            const alreadyLiked = coffee?.likedBy?.includes(email) || false
            const updateLike = alreadyLiked ?
                {
                    $pull: { likedBy: email }
                } :
                {
                    $addToSet: { likedBy: email }
                }

            const update = await coffeesCollection.updateOne(filter, updateLike)
            res.send({
                message: alreadyLiked ? 'Dislike' : 'Liked',
                liked: !alreadyLiked
            })
        })

        // handle orders
        app.post('/order/:coffeeId', async (req, res) => {
            const id = req.params.coffeeId
            const orderData = req.body
            const filter = { _id: new ObjectId(id) }

            const coffee = await coffeesCollection.findOne(filter)
            const coffeeQuantity = Number(coffee?.quantity) || 0;

            if (!coffee || coffeeQuantity <= 0) {
                return res.status(400).send({ message: 'Out of stock' })
            }

            const result = await ordersCollection.insertOne(orderData)
            if (result.acknowledged) {
                const newQuantity = Math.max(0, coffeeQuantity - 1);
                await coffeesCollection.updateOne(filter, {
                    $set: { quantity: newQuantity }
                })
            }
            res.send({ orderId: result.insertedId, message: 'Order placed successfully' })
        })

        // all orders by customer email
        app.get('/myOrders/:email', verifyToken, async (req, res) => {
            const email = req.params.email
            const decodedEmail = req.user.email

            if (decodedEmail !== email) {
                return res.status(403).send({ message: 'Forbidden Access!' })
            }

            const filter = { customerEmail: email }
            const allOrders = await ordersCollection.find(filter).toArray()

            for (const order of allOrders) {
                const orderId = order.coffeeId
                const allCoffeeData = await coffeesCollection.findOne({
                    _id: new ObjectId(orderId)
                })
                if (allCoffeeData) {
                    order.name = allCoffeeData.name
                    order.photo = allCoffeeData.photo
                    order.price = allCoffeeData.price
                    order.quantity = allCoffeeData.quantity
                }
            }
            res.send(allOrders)
        })


        // cancel order
        app.delete('/order/:orderId', async (req, res) => {
            const orderId = req.params.orderId
            const filter = { _id: new ObjectId(orderId) }
            const order = await ordersCollection.findOne(filter)

            if (!order) {
                return res.status(404).send({ message: "Order not found" })
            }

            const result = await ordersCollection.deleteOne(filter)

            // restore coffee quantity (+1)
            await coffeesCollection.updateOne(
                { _id: new ObjectId(order.coffeeId) },
                { $inc: { quantity: 1 } }
            )

            res.send({
                success: true,
                message: "Order cancelled successfully"
            })
        })


        // ...CART ENDPOINTS

        // Get user's cart
        app.get('/cart', verifyToken, async (req, res) => {
            try {
                const email = req.user.email
                const userCart = await cartCollection.findOne({ email })

                if (!userCart) {
                    return res.send({ items: [] })
                }

                // Fetch full coffee details for each item in cart
                const cartWithDetails = await Promise.all(
                    (userCart.items || []).map(async (item) => {
                        const coffeeData = await coffeesCollection.findOne({ _id: new ObjectId(item._id) })
                        return {
                            ...item,
                            name: coffeeData?.name,
                            photo: coffeeData?.photo,
                            price: coffeeData?.price
                        }
                    })
                )

                res.send({ items: cartWithDetails })
            } catch (error) {
                console.error('Error fetching cart:', error)
                res.status(500).send({ message: 'Error fetching cart' })
            }
        })

        // Add item to cart
        app.post('/cart', verifyToken, async (req, res) => {
            try {
                const email = req.user.email
                const { coffee } = req.body

                if (!coffee || !coffee._id) {
                    return res.status(400).send({ message: "Invalid coffee data" })
                }

                const coffeeId = new ObjectId(coffee._id)

                const userCart = await cartCollection.findOne({ email })

                if (userCart) {
                    const existingItem = userCart.items.find(item => item._id.equals(coffeeId))

                    if (existingItem) {
                        // Increase quantity if item exists
                        await cartCollection.updateOne(
                            { email, 'items._id': coffeeId },
                            { $inc: { 'items.$.cartQuantity': 1 } }
                        )
                    } else {
                        // Add new item to cart
                        await cartCollection.updateOne(
                            { email },
                            { $push: { items: { ...coffee, _id: coffeeId, cartQuantity: 1 } } }
                        )
                    }
                } else {
                    // Create new cart
                    await cartCollection.insertOne({
                        email,
                        items: [{ ...coffee, _id: coffeeId, cartQuantity: 1 }]
                    })
                }

                // Fetch updated cart
                const updatedCart = await cartCollection.findOne({ email })
                const cartWithDetails = await Promise.all(
                    (updatedCart.items || []).map(async (item) => {
                        const coffeeData = await coffeesCollection.findOne({ _id: new ObjectId(item._id) })
                        return {
                            ...item,
                            name: coffeeData?.name,
                            photo: coffeeData?.photo,
                            price: coffeeData?.price
                        }
                    })
                )

                res.send({ items: cartWithDetails })
            } catch (error) {
                console.error('Error adding to cart:', error)
                res.status(500).send({ message: 'Error adding to cart: ' + error.message })
            }
        })

        // Update cart item quantity
        app.patch('/cart/:coffeeId', verifyToken, async (req, res) => {
            try {
                const email = req.user.email
                const coffeeId = new ObjectId(req.params.coffeeId)
                const { quantity } = req.body

                await cartCollection.updateOne(
                    { email, 'items._id': coffeeId },
                    { $set: { 'items.$.cartQuantity': quantity } }
                )

                // Fetch updated cart
                const updatedCart = await cartCollection.findOne({ email })
                const cartWithDetails = await Promise.all(
                    (updatedCart.items || []).map(async (item) => {
                        const coffeeData = await coffeesCollection.findOne({ _id: new ObjectId(item._id) })
                        return {
                            ...item,
                            name: coffeeData?.name,
                            photo: coffeeData?.photo,
                            price: coffeeData?.price
                        }
                    })
                )

                res.send({ items: cartWithDetails })
            } catch (error) {
                console.error('Error updating cart:', error)
                res.status(500).send({ message: 'Error updating cart' })
            }
        })

        // Remove item from cart
        app.delete('/cart/:coffeeId', verifyToken, async (req, res) => {
            try {
                const email = req.user.email
                const coffeeId = new ObjectId(req.params.coffeeId)

                await cartCollection.updateOne(
                    { email },
                    { $pull: { items: { _id: coffeeId } } }
                )

                // Fetch updated cart
                const updatedCart = await cartCollection.findOne({ email })
                const cartWithDetails = await Promise.all(
                    (updatedCart?.items || []).map(async (item) => {
                        const coffeeData = await coffeesCollection.findOne({ _id: new ObjectId(item._id) })
                        return {
                            ...item,
                            name: coffeeData?.name,
                            photo: coffeeData?.photo,
                            price: coffeeData?.price
                        }
                    })
                )

                res.send({ items: cartWithDetails })
            } catch (error) {
                console.error('Error removing from cart:', error)
                res.status(500).send({ message: 'Error removing from cart' })
            }
        })

        // Clear entire cart
        app.delete('/cart', verifyToken, async (req, res) => {
            try {
                const email = req.user.email

                await cartCollection.updateOne(
                    { email },
                    { $set: { items: [] } }
                )

                res.send({ items: [] })
            } catch (error) {
                console.error('Error clearing cart:', error)
                res.status(500).send({ message: 'Error clearing cart' })
            }
        })

        // Create order from cart after payment success
        app.post('/create-order-from-cart', verifyToken, async (req, res) => {
            try {
                const email = req.user.email;
                const { paymentIntentId, status } = req.body;

                console.log('Creating order for email:', email);

                // Get user's cart
                const userCart = await cartCollection.findOne({ email });

                if (!userCart) {
                    console.log('No cart found for email:', email);
                    return res.status(400).send({ message: "Cart not found" });
                }

                if (!userCart.items || userCart.items.length === 0) {
                    console.log('Cart is empty for email:', email);
                    return res.status(400).send({ message: "Cart is empty" });
                }

                console.log(`Found ${userCart.items.length} items in cart`);

                // Create order for each item in cart
                const orderPromises = userCart.items.map(async (item) => {
                    // Convert quantities to numbers 
                    const cartQuantity = Number(item.cartQuantity) || 1;

                    const orderData = {
                        coffeeId: item._id,
                        customerEmail: email,
                        createdAt: new Date(),
                        paymentIntentId,
                        status: status || "confirmed",
                        quantity: cartQuantity,
                        priceAtPurchase: item.price,
                    };

                    const orderResult = await ordersCollection.insertOne(orderData);

                    // Decrease coffee quantity in stock
                    if (orderResult.acknowledged) {
                        // Get current coffee to ensure quantity is properly converted
                        const currentCoffee = await coffeesCollection.findOne({ _id: new ObjectId(item._id) });

                        if (currentCoffee) {
                            const currentQuantity = Number(currentCoffee.quantity) || 0;
                            const newQuantity = Math.max(0, currentQuantity - cartQuantity);

                            await coffeesCollection.updateOne(
                                { _id: new ObjectId(item._id) },
                                { $set: { quantity: newQuantity } }
                            );
                        }
                    }

                    return orderResult;
                });

                await Promise.all(orderPromises);

                // Clear the cart after all orders are created
                await cartCollection.updateOne(
                    { email },
                    { $set: { items: [] } }
                );

                res.send({
                    success: true,
                    message: "Orders created successfully from cart",
                });
            } catch (error) {
                console.error('Error creating order from cart:', error);
                res.status(500).send({ message: 'Error creating order from cart: ' + error.message });
            }
        })

        // payment intent api
        app.post("/create-payment-intent", verifyToken, async (req, res) => {
            const { type, coffeeId } = req.body;
            const email = req.user.email;

            let totalAmount = 0;

            // Single product order
            if (type === "single") {
                const coffee = await coffeesCollection.findOne({
                    _id: new ObjectId(coffeeId)
                });

                if (!coffee) {
                    return res.status(404).send({ message: "Coffee not found" });
                }

                totalAmount = coffee.price;
            }

            // Cart checkout
            if (type === "cart") {
                const cart = await cartCollection.findOne({ email });

                if (!cart || cart.items.length === 0) {
                    return res.status(400).send({ message: "Cart is empty" });
                }

                totalAmount = cart.items.reduce(
                    (sum, item) => sum + item.price * item.cartQuantity,
                    0
                );
            }

            // amount in cents
            const amount = totalAmount * 100;

            const paymentIntent = await stripe.paymentIntents.create({
                amount,
                currency: "usd",
                payment_method_types: ["card"],
            });

            res.send({
                clientSecret: paymentIntent.client_secret,
                totalAmount
            });
        });


        //save payment
        app.post("/save-payment", async (req, res) => {
            const paymentInfo = req.body
            const result = await paymentCollection.insertOne(paymentInfo)
            res.send(result)
        })



    } catch (error) {
        console.log("MongoDB connection failed", error)
    }
}

run().catch(console.dir)

// Test route
app.get('/', (req, res) => {
    res.send('coffee server is running')
})

// Start server
app.listen(port, () => {
    console.log(`Server running on port ${port}`)
})