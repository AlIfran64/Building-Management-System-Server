require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const admin = require("firebase-admin");
const app = express();
const port = process.env.PORT || 3000;

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

// Middleware
app.use(cors());
app.use(express.json());

// Firebase service key
const decodedKey = Buffer.from(process.env.FB_SERVICE_KEY, "base64").toString(
  "utf8"
);
const serviceAccount = JSON.parse(decodedKey);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.lds4lih.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

// MongoDB Client
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// Main function
async function run() {
  try {
    // await client.connect();

    // Collections----------------

    // Apartment collections
    const apartmentsCollection = client
      .db("brickBaseDb")
      .collection("apartments");

    // Agreement Collections
    const agreementsCollection = client
      .db("brickBaseDb")
      .collection("agreements");

    // Announcements Collections
    const announcementsCollection = client
      .db("brickBaseDb")
      .collection("announcements");

    // Coupons collection
    const couponsCollection = client.db("brickBaseDb").collection("coupons");

    // Users Collection
    const usersCollection = client.db("brickBaseDb").collection("users");

    // Payments Collection
    const paymentsCollection = client.db("brickBaseDb").collection("payments");

    // ---------------------------

    // Custom middleware-------------

    const verifyFirebaseToken = async (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader) {
        return res.status(401).send({ message: "Unauthorized Access" });
      }
      const token = authHeader.split(" ")[1];
      if (!token) {
        return res.status(401).send({ message: "Unauthorized Access" });
      }

      // Verify token
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        req.decoded = decoded;
        next();
      } catch (error) {
        return res.status(403).send({ message: "Forbidden Access" });
      }
    };

    // Verify User
    const verifyUser = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== "user") {
        return res
          .status(403)
          .send({ message: "Only users can access this route" });
      }
      next();
    };

    // Verify Member
    const verifyMember = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      if (!user || user.role !== "member") {
        return res
          .status(403)
          .send({ message: "Only members can access this route" });
      }
      next();
    };

    // Verify admin
    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const query = { email };
      const user = await usersCollection.findOne(query);
      if (!user || user.role !== "admin") {
        return res.status(403).send({ message: "Forbidden Access" });
      }
      next();
    };

    // ------------------------------

    // Apartments api--------------

    // GET
    app.get("/apartments", async (req, res) => {
      const result = await apartmentsCollection.find().toArray();
      res.send(result);
    });

    //GET: Apartment stats
    app.get("/apartments/stats", async (req, res) => {
      try {
        const apartments = await apartmentsCollection.find().toArray();
        const agreements = await agreementsCollection
          .find({ status: "checked" })
          .toArray();

        const occupiedMap = new Map();
        agreements.forEach((a) => {
          occupiedMap.set(`${a.blockName}-${a.apartmentNo}`, true);
        });

        const total = apartments.length;
        const unavailable = apartments.filter((ap) =>
          occupiedMap.has(`${ap.blockName}-${ap.apartmentNo}`)
        ).length;
        const available = total - unavailable;

        const availablePercentage = total
          ? ((available / total) * 100).toFixed(2)
          : 0;
        const unavailablePercentage = total
          ? ((unavailable / total) * 100).toFixed(2)
          : 0;

        res.send({
          total,
          availablePercentage,
          unavailablePercentage,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch apartment stats" });
      }
    });

    // ----------------------------

    // Agreements Api--------------jwt needed

    // GET: Fetch all pending agreements
    app.get("/agreements", verifyFirebaseToken, async (req, res) => {
      try {
        const { email } = req.query;

        // If email query param exists, fetch that user's "checked" agreement
        if (email) {
          const agreement = await agreementsCollection.findOne({
            email,
            status: "checked",
          });

          if (!agreement) {
            return res
              .status(404)
              .send({ message: "No active agreement found" });
          }

          return res.send(agreement);
        }

        // Otherwise, return all pending agreements (default behavior)
        const pendingAgreements = await agreementsCollection
          .find({ status: "pending" })
          .toArray();
        res.send(pendingAgreements);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch agreements" });
      }
    });

    // GET: Specific get by id
    app.get("/agreements/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const agreement = await agreementsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!agreement) {
          return res.status(404).send({ message: "Agreement not found" });
        }
        res.send(agreement);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch agreement" });
      }
    });

    // POST
    app.post(
      "/agreements",
      verifyFirebaseToken,
      verifyUser,
      async (req, res) => {
        try {
          const agreementData = req.body;

          //1. Check if user already has an active or pending agreement
          const existingAgreement = await agreementsCollection.findOne({
            email: agreementData.email,
            status: { $in: ["pending", "checked"] },
          });

          if (existingAgreement) {
            return res.status(400).send({
              message:
                "User already has an existing agreement (pending or approved).",
            });
          }

          //2. Check if apartment is already assigned to a member
          const checkedAgreements = await agreementsCollection
            .find({
              blockName: agreementData.blockName,
              apartmentNo: agreementData.apartmentNo,
              status: "checked",
            })
            .toArray();

          if (checkedAgreements.length > 0) {
            const emails = checkedAgreements.map((ag) => ag.email);

            const memberUser = await usersCollection.findOne({
              email: { $in: emails },
              role: "member",
            });

            if (memberUser) {
              return res.status(400).send({
                message: "This apartment is already assigned to a member.",
              });
            }
          }

          const result = await agreementsCollection.insertOne(agreementData);
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Failed to create agreement" });
        }
      }
    );

    // PATCH /agreements/:id
    app.patch(
      "/agreements/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const id = req.params.id;

          if (!ObjectId.isValid(id)) {
            return res.status(400).send({ message: "Invalid agreement ID" });
          }

          const { status, role } = req.body;
          const filter = { _id: new ObjectId(id) };

          const updateFields = {
            status: status || "checked",
          };

          // If admin accepts the agreement and assigns "member" role, also set acceptedDate
          if (role === "member") {
            updateFields.acceptedDate = new Date();
          }

          const updateDoc = {
            $set: updateFields,
          };

          const agreementResult = await agreementsCollection.updateOne(
            filter,
            updateDoc
          );

          // Also update the user's role if set to "member"
          if (role === "member") {
            const agreement = await agreementsCollection.findOne(filter);
            const userEmail = agreement?.email;

            if (userEmail) {
              await usersCollection.updateOne(
                { email: userEmail },
                { $set: { role: "member" } }
              );
            }
          }

          res.send({ message: "Agreement updated successfully" });
        } catch (error) {
          res.status(500).send({ message: "Internal Server Error" });
        }
      }
    );

    // ----------------------------

    // Announcements api------------

    app.get("/announcements", async (req, res) => {
      const announcements = await announcementsCollection
        .find()
        .sort({ date: -1 })
        .toArray();
      res.send(announcements);
    });

    // POST /announcements
    app.post(
      "/announcements",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const announcement = req.body;
        const result = await announcementsCollection.insertOne(announcement);
        res.send(result);
      }
    );

    // -----------------------------

    // Users api-------------------

    // GET: Get user role by email
    app.get("/users/:email/role", async (req, res) => {
      try {
        const email = req.params.email;

        if (!email) {
          return res.status(400).send({ message: "Email is required" });
        }

        const user = await usersCollection.findOne({ email });

        if (!user) {
          return res.status(404).send({ message: "User not found" });
        }

        // Send the role in response
        res.send({ role: user.role });
      } catch (error) {
        return res.status(500).send({ message: "Failed to get role" });
      }
    });

    // GET: User Stats
    app.get("/users/stats", async (req, res) => {
      try {
        const users = await usersCollection.find().toArray();
        const total = users.length;
        const members = users.filter((user) => user.role === "member").length;

        res.send({
          totalUsers: total,
          totalMembers: members,
        });
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch user stats" });
      }
    });

    // POST
    app.post("/users", async (req, res) => {
      const email = req.body.email;
      const existingUser = await usersCollection.findOne({ email });

      if (existingUser) {
        return res.status(200).send({ message: "User already exists" });
      }

      const user = req.body;
      const result = await usersCollection.insertOne(user);
      res.send(result);
    });

    // GET /users?role=member
    app.get("/users", async (req, res) => {
      const role = req.query.role;
      const users = await usersCollection.find({ role }).toArray();
      res.send(users);
    });

    // PATCH /users/:id with { role: 'user' }
    app.patch(
      "/users/:id",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        const id = req.params.id;
        const { role } = req.body;
        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );
        res.send(result);
      }
    );

    // ----------------------------

    // Coupons api-----------------
    // GET all coupons
    app.get("/coupons", async (req, res) => {
      try {
        const result = await couponsCollection
          .find()
          .sort({ createdAt: -1 })
          .toArray();
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to fetch coupons" });
      }
    });

    // POST create new coupon
    app.post("/coupons", verifyFirebaseToken, verifyAdmin, async (req, res) => {
      try {
        const { code, discount, description, status } = req.body;

        if (!code || !discount || !description) {
          return res.status(400).send({ message: "All fields are required" });
        }

        const existing = await couponsCollection.findOne({ code });
        if (existing) {
          return res
            .status(400)
            .send({ message: "Coupon code already exists" });
        }

        const newCoupon = {
          code,
          discount: Number(discount),
          description,
          status: status || "available", // set default here
          createdAt: new Date(),
        };

        const result = await couponsCollection.insertOne(newCoupon);
        res.send(result);
      } catch (error) {
        res.status(500).send({ message: "Failed to create coupon" });
      }
    });

    // PATCH: Update coupon status
    app.patch(
      "/coupons/:id/status",
      verifyFirebaseToken,
      verifyAdmin,
      async (req, res) => {
        try {
          const { status } = req.body;
          const { id } = req.params;

          if (!["available", "unavailable"].includes(status)) {
            return res.status(400).send({ message: "Invalid status" });
          }

          const result = await couponsCollection.updateOne(
            { _id: new ObjectId(id) },
            { $set: { status } }
          );

          if (result.modifiedCount === 0) {
            return res
              .status(404)
              .send({ message: "Coupon not found or status unchanged" });
          }

          res.send({ message: "Status updated successfully" });
        } catch (error) {
          res.status(500).send({ message: "Failed to update coupon status" });
        }
      }
    );

    // ----------------------------

    // Payment api-----------------

    // GET /payments?email=user@example.com
    app.get(
      "/payments",
      verifyFirebaseToken,
      verifyMember,
      async (req, res) => {
        const email = req.query.email;
        if (!email) return res.status(400).send({ message: "Missing email" });

        const payments = await paymentsCollection
          .find({ email })
          .sort({ paymentDate: -1 }) // Optional: newest first
          .toArray();

        res.send(payments);
      }
    );

    // POST
    app.post(
      "/create-payment-intent",
      verifyFirebaseToken,
      verifyMember,
      async (req, res) => {
        const amountInCents = req.body.amountInCents;
        try {
          const paymentIntent = await stripe.paymentIntents.create({
            amount: amountInCents,
            currency: "usd",
            payment_method_types: ["card"],
          });
          res.json({ clientSecret: paymentIntent.client_secret });
        } catch (error) {
          res.status(500).json({ error: error.message });
        }
      }
    );

    // POST /payments
    app.post(
      "/payments",
      verifyFirebaseToken,
      verifyMember,
      async (req, res) => {
        try {
          const paymentData = req.body;

          if (!paymentData.email || !paymentData.month || !paymentData.rent) {
            return res.status(400).send({ message: "Missing required fields" });
          }

          const result = await paymentsCollection.insertOne(paymentData);
          res.send(result);
        } catch (error) {
          res.status(500).send({ message: "Payment failed" });
        }
      }
    );

    // ----------------------------

    // await client.db("admin").command({ ping: 1 });
    // console.log("Successfully connected to MongoDB!");

    // Example route
    app.get("/", (req, res) => {
      res.send("BrickBase Server is up and running!");
    });

    // Start server
    app.listen(port, () => {
      console.log(`Server is listening on ${port}`);
    });
  } catch (error) {
    console.error("MongoDB connection failed:", error);
  }
}

run().catch(console.dir);
